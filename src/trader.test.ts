import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Config } from "./config.js";
import type { TradeJournalEntry } from "./journal.js";
import { TOKEN_2022_PROGRAM_ID } from "./transaction-policy.js";
import {
  assertClassicSellMintDecimals,
  assertSpendableSellTokenAccount,
  assertRecentBlockhashValid,
  assertComputeHeadroom,
  assertSafeBuyMintAccount,
  assertTradeIntentFresh,
  assertTransactionSucceeded,
  classifySubmissionStatus,
  computeUnitUtilizationBps,
  executeTrade,
  maxBuySpendLamports,
  maxBuySpendSol,
  pumpswapPointReadAddresses,
  pumpswapSimulationAccountConfig,
  reconcileUnresolvedSubmissions,
  refreshTransactionBlockhash,
  requireSimulationComputeUnits,
  requiresDurableTradeAudit,
  serializeLiveBuy,
} from "./trader.js";

const sellMint = "So11111111111111111111111111111111111111112";
const sellOwner = "11111111111111111111111111111111";
const splTokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

test("maxBuySpendLamports includes the configured slippage margin", () => {
  assert.equal(maxBuySpendLamports(0.01, 5), 10_500_000n);
  assert.equal(maxBuySpendSol(0.01, 5), 0.0105);
});

test("compute utilization uses ceiling basis points and rejects inconsistent simulation data", () => {
  assert.equal(computeUnitUtilizationBps(0, 200_000), 0);
  assert.equal(computeUnitUtilizationBps(150_001, 200_000), 7_501);
  assert.equal(computeUnitUtilizationBps(200_000, 200_000), 10_000);
  assert.throws(
    () => computeUnitUtilizationBps(200_001, 200_000),
    /above declared limit/,
  );
  assert.throws(() => computeUnitUtilizationBps(Number.NaN, 200_000), /nonnegative safe integer/);
});

test("live buys require simulation compute units while exits permit missing metadata", () => {
  assert.equal(requireSimulationComputeUnits(150_000, 200_000, true), 7_500);
  assert.equal(requireSimulationComputeUnits(null, 200_000, false), null);
  assert.throws(
    () => requireSimulationComputeUnits(null, 200_000, true),
    /Live buy simulation did not report compute units consumed/,
  );
});

test("PumpSwap simulation requests only unique policy-verified vault accounts", () => {
  assert.equal(pumpswapSimulationAccountConfig([]), undefined);
  const trades = [
    {
      poolAddress: "pool-a",
      baseMint: "base-a",
      quoteMint: "quote-a",
      poolBaseTokenAccount: "base-vault-a",
      poolQuoteTokenAccount: "quote-vault-a",
      feeConfigAddress: "fee-config",
    },
    {
      poolAddress: "pool-a",
      baseMint: "base-a",
      quoteMint: "quote-a",
      poolBaseTokenAccount: "base-vault-a",
      poolQuoteTokenAccount: "quote-vault-a",
      feeConfigAddress: "fee-config",
    },
    {
      poolAddress: "pool-b",
      baseMint: "base-b",
      quoteMint: "quote-b",
      poolBaseTokenAccount: "base-vault-b",
      poolQuoteTokenAccount: "quote-vault-b",
      feeConfigAddress: "fee-config",
    },
  ];
  assert.deepEqual(pumpswapSimulationAccountConfig(trades), {
    encoding: "base64",
    addresses: ["base-vault-a", "quote-vault-a", "base-vault-b", "quote-vault-b"],
  });
  assert.deepEqual(pumpswapPointReadAddresses(trades), [
    "base-vault-a",
    "quote-vault-a",
    "base-vault-b",
    "quote-vault-b",
    "fee-config",
  ]);
});

test("compute headroom enforces an optional live-buy margin at the exact boundary", () => {
  assert.doesNotThrow(() => assertComputeHeadroom(9_000, 1_000, true));
  assert.throws(
    () => assertComputeHeadroom(9_001, 1_000, true),
    /headroom 999 bps is below required 1000 bps/,
  );
  assert.doesNotThrow(() => assertComputeHeadroom(9_999, undefined, true));
  assert.doesNotThrow(() => assertComputeHeadroom(9_999, 1_000, false));
  assert.throws(() => assertComputeHeadroom(5_000, 10_000, true), /between 1 and 9999/);
});

function rawBuyMint(overrides: {
  owner?: PublicKey;
  executable?: boolean;
  dataLength?: number;
  mintAuthorityOption?: number;
  freezeAuthorityOption?: number;
  supply?: bigint;
  decimals?: number;
  initialized?: number;
} = {}): unknown {
  const data = Buffer.alloc(overrides.dataLength ?? 82);
  if (data.length === 82) {
    data.writeUInt32LE(overrides.mintAuthorityOption ?? 0, 0);
    data.writeBigUInt64LE(overrides.supply ?? 1_000_000_000n, 36);
    data.writeUInt8(overrides.decimals ?? 6, 44);
    data.writeUInt8(overrides.initialized ?? 1, 45);
    data.writeUInt32LE(overrides.freezeAuthorityOption ?? 0, 46);
  }
  return {
    executable: overrides.executable ?? false,
    owner: overrides.owner ?? splTokenProgram,
    data,
  };
}

test("buy mint preflight deterministically decodes fixed classic SPL authority state", () => {
  assert.deepEqual(assertSafeBuyMintAccount(rawBuyMint()), {
    tokenProgram: splTokenProgram.toBase58(),
    decimals: 6,
    supplyRaw: "1000000000",
    mintAuthority: null,
    freezeAuthority: null,
  });
  assert.throws(() => assertSafeBuyMintAccount(null), /does not exist/);
  assert.throws(() => assertSafeBuyMintAccount(rawBuyMint({ mintAuthorityOption: 1 })), /active mint authority/);
  assert.throws(() => assertSafeBuyMintAccount(rawBuyMint({ freezeAuthorityOption: 1 })), /active freeze authority/);
  assert.throws(() => assertSafeBuyMintAccount(rawBuyMint({ supply: 0n })), /zero supply/);
  assert.throws(() => assertSafeBuyMintAccount(rawBuyMint({ initialized: 0 })), /not initialized/);
  assert.throws(() => assertSafeBuyMintAccount(rawBuyMint({ mintAuthorityOption: 2 })), /invalid mint authority option/);
  assert.throws(() => assertSafeBuyMintAccount(rawBuyMint({ freezeAuthorityOption: 2 })), /invalid freeze authority option/);
  assert.throws(() => assertSafeBuyMintAccount(rawBuyMint({ dataLength: 83 })), /not a supported classic 82-byte/);
  assert.throws(() => assertSafeBuyMintAccount(rawBuyMint({ executable: true })), /not a supported classic 82-byte/);
  assert.throws(
    () => assertSafeBuyMintAccount(rawBuyMint({ owner: Keypair.generate().publicKey })),
    /not the classic SPL Token program/,
  );
  assert.throws(
    () => assertSafeBuyMintAccount(rawBuyMint({ owner: new PublicKey(TOKEN_2022_PROGRAM_ID) })),
    /Token-2022 mint is not eligible for live buys/,
  );
});

test("assertTransactionSucceeded accepts a successful confirmation", () => {
  assert.doesNotThrow(() => assertTransactionSucceeded(null));
});

test("assertTransactionSucceeded rejects an on-chain failure", () => {
  assert.throws(
    () => assertTransactionSucceeded({ InstructionError: [0, { Custom: 6001 }] }),
    /Transaction failed on-chain.*InstructionError/,
  );
});

test("submission status classification resolves only definitive RPC outcomes", () => {
  assert.equal(classifySubmissionStatus(null), "unresolved");
  assert.equal(classifySubmissionStatus({ err: null, confirmationStatus: "processed" }), "unresolved");
  assert.equal(classifySubmissionStatus({ err: { InstructionError: [0, "InvalidArgument"] }, confirmationStatus: "processed" }), "unresolved");
  assert.equal(classifySubmissionStatus({ err: null, confirmationStatus: null }), "unresolved");
  assert.equal(classifySubmissionStatus({ err: null, confirmationStatus: "confirmed" }), "confirmed");
  assert.equal(classifySubmissionStatus({ err: null, confirmationStatus: "finalized" }), "confirmed");
  assert.equal(classifySubmissionStatus({
    err: { InstructionError: [0, { Custom: 6001 }] },
    confirmationStatus: "confirmed",
  }), "failed");
});

test("submission reconciliation journals definitive outcomes and preserves ambiguity", async () => {
  const base = {
    schemaVersion: 2 as const,
    timestamp: "2026-08-31T12:00:00.000Z",
    decisionId: "68adf508-1e9b-4c63-b4a7-2910d2155d0a",
    action: "buy" as const,
    mint: sellMint,
    amount: 0.01,
    denominatedInSol: true,
    mode: "LIVE" as const,
    wallet: sellOwner,
    status: "submitted" as const,
    rejectionReason: null,
  };
  const entries: TradeJournalEntry[] = [
    { ...base, signature: "ConfirmedSignature" },
    { ...base, decisionId: "ee3f998b-f52c-4535-b66d-29c76f6c99a4", signature: "FailedSignature" },
    { ...base, decisionId: "fa219392-c710-44b2-9b08-78eda529c407", signature: "UnknownSignature" },
  ];
  const journaled: TradeJournalEntry[] = [];
  const connection = {
    getSignatureStatuses: async (signatures: string[], options?: { searchTransactionHistory: boolean }) => {
      assert.deepEqual(signatures, ["ConfirmedSignature", "FailedSignature", "UnknownSignature"]);
      assert.deepEqual(options, { searchTransactionHistory: true });
      return {
        context: { slot: 1 },
        value: [
          { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" as const },
          {
            slot: 1,
            confirmations: null,
            err: { InstructionError: [0, { Custom: 6001 }] },
            confirmationStatus: "finalized" as const,
          },
          null,
        ],
      };
    },
  };

  const unresolved = await reconcileUnresolvedSubmissions(
    entries,
    connection,
    "ignored.jsonl",
    async (_path, entry) => {
      journaled.push(entry);
      return true;
    },
  );

  assert.deepEqual(unresolved, [entries[2]]);
  assert.deepEqual(journaled.map((entry) => entry.status), ["confirmed", "failed"]);
  assert.equal(journaled[0]?.rejectionReason, null);
  assert.match(journaled[1]?.rejectionReason ?? "", /Transaction failed on-chain.*InstructionError/);
});

test("submission reconciliation fails closed when its terminal journal write fails", async () => {
  const entry: TradeJournalEntry = {
    schemaVersion: 2,
    timestamp: "2026-08-31T12:00:00.000Z",
    decisionId: "68adf508-1e9b-4c63-b4a7-2910d2155d0a",
    action: "buy",
    mint: sellMint,
    amount: 0.01,
    denominatedInSol: true,
    mode: "LIVE",
    wallet: sellOwner,
    signature: "ConfirmedSignature",
    status: "submitted",
  };
  const connection = {
    getSignatureStatuses: async () => ({
      context: { slot: 1 },
      value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" as const }],
    }),
  };

  await assert.rejects(reconcileUnresolvedSubmissions(
    [entry],
    connection,
    "ignored.jsonl",
    async () => false,
  ), /journal reconciliation failed for ConfirmedSignature/);
});

test("recent blockhash validation fails closed with stage context", async () => {
  const connection = (value: boolean) => ({
    isBlockhashValid: async (
      blockhash: string,
      config?: { commitment?: string; minContextSlot?: number },
    ) => {
      assert.equal(blockhash, "RecentBlockhash");
      assert.deepEqual(config, { commitment: "confirmed" });
      return { context: { slot: 1 }, value };
    },
  });

  await assert.doesNotReject(assertRecentBlockhashValid(
    connection(true),
    "RecentBlockhash",
    "signing",
  ));
  await assert.rejects(assertRecentBlockhashValid(
    connection(false),
    "RecentBlockhash",
    "broadcast",
  ), /blockhash expired before broadcast/);
  await assert.rejects(assertRecentBlockhashValid(
    { isBlockhashValid: async () => { throw new Error("RPC unavailable"); } },
    "RecentBlockhash",
    "signing",
  ), /Cannot verify transaction blockhash before signing: RPC unavailable/);
});

test("blockhash refresh replaces the remote hash and clears stale signatures", async () => {
  const wallet = Keypair.generate();
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [],
  }).compileToLegacyMessage());
  transaction.sign([wallet]);
  assert.equal(transaction.signatures[0]?.some((byte) => byte !== 0), true);
  const freshBlockhash = Keypair.generate().publicKey.toBase58();

  const lease = await refreshTransactionBlockhash({
    getLatestBlockhash: async (commitment) => {
      assert.equal(commitment, "confirmed");
      return { blockhash: freshBlockhash, lastValidBlockHeight: 123_456 };
    },
  }, transaction);

  assert.deepEqual(lease, { blockhash: freshBlockhash, lastValidBlockHeight: 123_456 });
  assert.equal(transaction.message.recentBlockhash, freshBlockhash);
  assert.equal(transaction.signatures[0]?.every((byte) => byte === 0), true);
});

test("live buy serialization is FIFO, releases after failure, and permits bypass", async () => {
  const events: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted: () => void = () => undefined;
  const firstDidStart = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const first = serializeLiveBuy(true, async () => {
    events.push("first-start");
    firstStarted();
    await firstBlocked;
    events.push("first-fail");
    throw new Error("expected failure");
  });
  await firstDidStart;
  const second = serializeLiveBuy(true, async () => {
    events.push("second");
    return "second-result";
  });
  const bypass = await serializeLiveBuy(false, async () => {
    events.push("bypass");
    return "bypass-result";
  });

  assert.equal(bypass, "bypass-result");
  assert.deepEqual(events, ["first-start", "bypass"]);
  releaseFirst();
  await assert.rejects(first, /expected failure/);
  assert.equal(await second, "second-result");
  assert.deepEqual(events, ["first-start", "bypass", "first-fail", "second"]);
});

test("trade intent freshness accepts the boundary and rejects stale or future candidates", () => {
  const candidateAt = "2026-08-31T12:00:00.000Z";
  assert.doesNotThrow(() => assertTradeIntentFresh(
    candidateAt,
    10_000,
    "broadcast",
    Date.parse("2026-08-31T12:00:10.000Z"),
  ));
  assert.throws(() => assertTradeIntentFresh(
    candidateAt,
    10_000,
    "broadcast",
    Date.parse("2026-08-31T12:00:10.001Z"),
  ), /expired before broadcast: age 10001ms exceeds 10000ms/);
  assert.throws(() => assertTradeIntentFresh(
    candidateAt,
    10_000,
    "signing",
    Date.parse("2026-08-31T11:59:59.999Z"),
  ), /timestamp is in the future/);
});

function rawSellTokenAccount(
  state: 0 | 1 | 2,
  amount: string,
  overrides: {
    mint?: PublicKey;
    owner?: PublicKey;
    programOwner?: PublicKey;
    executable?: boolean;
    dataLength?: number;
    delegateOption?: number;
    nativeOption?: number;
    closeAuthorityOption?: number;
  } = {},
): unknown {
  const data = Buffer.alloc(overrides.dataLength ?? 165);
  if (data.length === 165) {
    (overrides.mint ?? new PublicKey(sellMint)).toBuffer().copy(data, 0);
    (overrides.owner ?? new PublicKey(sellOwner)).toBuffer().copy(data, 32);
    data.writeBigUInt64LE(BigInt(amount), 64);
    data.writeUInt32LE(overrides.delegateOption ?? 0, 72);
    data.writeUInt8(state, 108);
    data.writeUInt32LE(overrides.nativeOption ?? 0, 109);
    data.writeUInt32LE(overrides.closeAuthorityOption ?? 0, 129);
  }
  return {
    account: {
      executable: overrides.executable ?? false,
      owner: overrides.programOwner ?? splTokenProgram,
      data,
    },
  };
}

test("sell preflight requires a nonzero initialized token account", () => {
  assert.throws(
    () => assertSpendableSellTokenAccount([], "100%", sellMint, sellOwner),
    /no token account/,
  );
  assert.throws(
    () => assertSpendableSellTokenAccount(
      [rawSellTokenAccount(1, "0")],
      "100%",
      sellMint,
      sellOwner,
    ),
    /balance.*zero/,
  );
  assert.throws(
    () => assertSpendableSellTokenAccount(
      [rawSellTokenAccount(2, "100")],
      "100%",
      sellMint,
      sellOwner,
    ),
    /balance.*frozen/,
  );
  assert.doesNotThrow(() => assertSpendableSellTokenAccount([
    rawSellTokenAccount(1, "0"),
    rawSellTokenAccount(1, "100"),
  ], "100%", sellMint, sellOwner));
});

test("sell preflight checks explicit token amounts in raw units", () => {
  assert.throws(() => assertSpendableSellTokenAccount([
    rawSellTokenAccount(1, "1000000"),
  ], 1, sellMint, sellOwner), /requires decoded mint decimals between 0 and 255/);
  assert.equal(assertSpendableSellTokenAccount([
    rawSellTokenAccount(1, "750000"),
    rawSellTokenAccount(1, "500000"),
  ], 1.25, sellMint, sellOwner, 6), 1_250_000n);
  assert.throws(() => assertSpendableSellTokenAccount([
    rawSellTokenAccount(1, "1249999"),
  ], 1.25, sellMint, sellOwner, 6), /Insufficient token balance/);
  assert.throws(() => assertSpendableSellTokenAccount([
    rawSellTokenAccount(1, "1000000"),
  ], 0.0000001, sellMint, sellOwner, 6), /more precision than the token supports/);
});

test("sell preflight derives a floored raw cap for percentage sells", () => {
  assert.equal(assertSpendableSellTokenAccount([
    rawSellTokenAccount(1, "101"),
  ], "50%", sellMint, sellOwner), 50n);
  assert.throws(() => assertSpendableSellTokenAccount([
    rawSellTokenAccount(1, "1"),
  ], "1%", sellMint, sellOwner), /rounds down to zero/);
});

test("sell preflight verifies RPC-returned mint and owner", () => {
  const account = rawSellTokenAccount(1, "100");
  assert.throws(
    () => assertSpendableSellTokenAccount([account], "100%", "UnexpectedMint", sellOwner),
    /unexpected mint/,
  );
  assert.throws(
    () => assertSpendableSellTokenAccount([account], "100%", sellMint, "UnexpectedOwner"),
    /unexpected owner/,
  );
});

test("sell preflight fails closed on malformed raw account data", () => {
  assert.throws(
    () => assertSpendableSellTokenAccount(
      [{ account: { data: Buffer.alloc(0) } }],
      "100%",
      sellMint,
      sellOwner,
    ),
    /response is malformed/,
  );
  assert.throws(
    () => assertSpendableSellTokenAccount([
      rawSellTokenAccount(1, "100", { dataLength: 164 }),
    ], "100%", sellMint, sellOwner),
    /not a supported classic 165-byte/,
  );
  assert.throws(
    () => assertSpendableSellTokenAccount([
      rawSellTokenAccount(1, "100", { delegateOption: 2 }),
    ], "100%", sellMint, sellOwner),
    /invalid delegate option tag/,
  );
  assert.throws(
    () => assertSpendableSellTokenAccount([
      rawSellTokenAccount(1, "100", { nativeOption: 2 }),
    ], "100%", sellMint, sellOwner),
    /invalid native account option tag/,
  );
  assert.throws(
    () => assertSpendableSellTokenAccount([
      rawSellTokenAccount(1, "100", { closeAuthorityOption: 2 }),
    ], "100%", sellMint, sellOwner),
    /invalid close authority option tag/,
  );
  assert.throws(
    () => assertSpendableSellTokenAccount([
      rawSellTokenAccount(1, "100", { programOwner: new PublicKey(TOKEN_2022_PROGRAM_ID) }),
    ], "100%", sellMint, sellOwner),
    /not a supported classic 165-byte/,
  );
  assert.throws(
    () => assertSpendableSellTokenAccount([
      rawSellTokenAccount(1, "100", { executable: true }),
    ], "100%", sellMint, sellOwner),
    /not a supported classic 165-byte/,
  );
  assert.throws(
    () => assertSpendableSellTokenAccount([
      rawSellTokenAccount(0, "100"),
    ], "100%", sellMint, sellOwner),
    /not initialized/,
  );
});

test("numeric sell mint decoding permits authorities but rejects unsupported layouts", () => {
  assert.equal(assertClassicSellMintDecimals(rawBuyMint({ mintAuthorityOption: 1 })), 6);
  assert.equal(assertClassicSellMintDecimals(rawBuyMint({ freezeAuthorityOption: 1 })), 6);
  assert.throws(() => assertClassicSellMintDecimals(null), /does not exist/);
  assert.throws(
    () => assertClassicSellMintDecimals(rawBuyMint({ owner: new PublicKey(TOKEN_2022_PROGRAM_ID) })),
    /Token-2022 numeric sells are not supported/,
  );
  assert.throws(
    () => assertClassicSellMintDecimals(rawBuyMint({ dataLength: 83 })),
    /not a supported classic 82-byte/,
  );
});

test("executeTrade journals a candidate and its validation failure", async () => {
  const entries: TradeJournalEntry[] = [];
  const config = {
    SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    LIVE_TRADING: false,
    AUTO_BUY: false,
    BUY_AMOUNT_SOL: 0.01,
    MAX_BUYS_PER_SESSION: 1,
    MAX_SESSION_BUY_SOL: 0.05,
    MIN_SOL_RESERVE: 0.02,
    SLIPPAGE_PERCENT: 5,
    PRIORITY_FEE_SOL: 0.00005,
    MAX_TRADE_INTENT_AGE_MS: 10_000,
    TRADE_JOURNAL_ENABLED: true,
    TRADE_JOURNAL_PATH: "ignored.jsonl",
    DASHBOARD_EVENT_LOG_ENABLED: false,
    DASHBOARD_EVENT_LOG_PATH: "ignored-dashboard.jsonl",
    DASHBOARD_EVENT_QUEUE_CAPACITY: 1_000,
    DASHBOARD_API_HOST: "127.0.0.1",
    DASHBOARD_API_PORT: 8_787,
      DASHBOARD_PROJECTION_STALE_AFTER_MS: 60_000,
      ALLOWED_PROGRAM_IDS: ["allowed-program"],
  } satisfies Config;

  await assert.rejects(
    executeTrade(
      { action: "buy", mint: "not-a-public-key", amount: 0.01, denominatedInSol: true },
      config,
      Keypair.generate(),
      new Connection(config.SOLANA_RPC_URL),
      async (_path, entry) => {
        entries.push(entry);
        return true;
      },
    ),
    /Non-base58 character/,
  );

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.status, "candidate");
  assert.equal(entries[1]?.status, "rejected");
  assert.equal(entries[0]?.decisionId, entries[1]?.decisionId);
  assert.match(entries[1]?.rejectionReason ?? "", /Non-base58 character/);

  await assert.rejects(
    executeTrade(
      { action: "sell", mint: sellMint, amount: "0%", denominatedInSol: false },
      config,
      Keypair.generate(),
      new Connection(config.SOLANA_RPC_URL),
      async (_path, entry) => {
        entries.push(entry);
        return true;
      },
    ),
    /between 1% and 100%/,
  );
  await assert.rejects(
    executeTrade(
      { action: "sell", mint: sellMint, amount: 1, denominatedInSol: true },
      config,
      Keypair.generate(),
      new Connection(config.SOLANA_RPC_URL),
      async (_path, entry) => {
        entries.push(entry);
        return true;
      },
    ),
    /denominated in tokens or a percentage/,
  );
  assert.equal(entries.length, 6);
  assert.equal(entries[3]?.status, "rejected");
  assert.equal(entries[5]?.status, "rejected");
});

test("live buys fail closed when durable pre-broadcast journaling is unavailable", async () => {
  const wallet = Keypair.generate();
  const baseConfig = {
    SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    LIVE_TRADING: true,
    LIVE_TRADING_ARM_PATH: "ignored.armed",
    AUTO_BUY: false,
    BUY_AMOUNT_SOL: 0.01,
    MAX_BUYS_PER_SESSION: 1,
    MAX_SESSION_BUY_SOL: 0.05,
    MIN_SOL_RESERVE: 0.02,
    SLIPPAGE_PERCENT: 5,
    PRIORITY_FEE_SOL: 0.00005,
    MAX_TRADE_INTENT_AGE_MS: 10_000,
    TRADE_JOURNAL_PATH: "ignored.jsonl",
    DASHBOARD_EVENT_LOG_ENABLED: false,
    DASHBOARD_EVENT_LOG_PATH: "ignored-dashboard.jsonl",
    DASHBOARD_EVENT_QUEUE_CAPACITY: 1_000,
    DASHBOARD_API_HOST: "127.0.0.1" as const,
    DASHBOARD_API_PORT: 8_787,
    DASHBOARD_PROJECTION_STALE_AFTER_MS: 60_000,
    ALLOWED_PROGRAM_IDS: ["allowed-program"],
  };
  const request = { action: "buy", mint: sellMint, amount: 0.01, denominatedInSol: true } as const;

  await assert.rejects(
    executeTrade(
      request,
      { ...baseConfig, TRADE_JOURNAL_ENABLED: false },
      wallet,
      new Connection(baseConfig.SOLANA_RPC_URL),
    ),
    /require TRADE_JOURNAL_ENABLED=true/,
  );
  await assert.rejects(
    executeTrade(
      request,
      { ...baseConfig, TRADE_JOURNAL_ENABLED: true },
      wallet,
      new Connection(baseConfig.SOLANA_RPC_URL),
      async () => false,
    ),
    /journal append failed at candidate/,
  );
});

test("live buys are fenced by malformed or unresolved journal state", async () => {
  const wallet = Keypair.generate();
  const config = {
    SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    LIVE_TRADING: true,
    LIVE_TRADING_ARM_PATH: "ignored.armed",
    AUTO_BUY: false,
    BUY_AMOUNT_SOL: 0.01,
    MAX_BUYS_PER_SESSION: 1,
    MAX_SESSION_BUY_SOL: 0.05,
    MIN_SOL_RESERVE: 0.02,
    SLIPPAGE_PERCENT: 5,
    PRIORITY_FEE_SOL: 0.00005,
    MAX_TRADE_INTENT_AGE_MS: 10_000,
    TRADE_JOURNAL_ENABLED: true,
    TRADE_JOURNAL_PATH: "ignored.jsonl",
    DASHBOARD_EVENT_LOG_ENABLED: false,
    DASHBOARD_EVENT_LOG_PATH: "ignored-dashboard.jsonl",
    DASHBOARD_EVENT_QUEUE_CAPACITY: 1_000,
    DASHBOARD_API_HOST: "127.0.0.1" as const,
    DASHBOARD_API_PORT: 8_787,
    DASHBOARD_PROJECTION_STALE_AFTER_MS: 60_000,
    ALLOWED_PROGRAM_IDS: ["allowed-program"],
  } satisfies Config;
  const request = { action: "buy", mint: sellMint, amount: 0.01, denominatedInSol: true } as const;
  const entries: TradeJournalEntry[] = [];
  const journal = async (_path: string, entry: TradeJournalEntry): Promise<boolean> => {
    entries.push(entry);
    return true;
  };

  await assert.rejects(executeTrade(
    request,
    config,
    wallet,
    new Connection(config.SOLANA_RPC_URL),
    journal,
    async () => ({ unresolvedSubmissions: [], invalidLines: 1, missing: false }),
  ), /journal contains 1 invalid line/);

  const unresolved = {
    timestamp: "2026-08-31T12:00:00.000Z",
    schemaVersion: 2 as const,
    decisionId: "68adf508-1e9b-4c63-b4a7-2910d2155d0a",
    action: "buy" as const,
    mint: sellMint,
    amount: 0.01,
    denominatedInSol: true,
    mode: "LIVE" as const,
    wallet: wallet.publicKey.toBase58(),
    signature: "ExistingSignature",
    status: "submitted" as const,
  };
  await assert.rejects(executeTrade(
    request,
    config,
    wallet,
    {
      getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [null] }),
    } as unknown as Connection,
    journal,
    async () => ({ unresolvedSubmissions: [unresolved], invalidLines: 0, missing: false }),
  ), /unresolved submission ExistingSignature/);
  assert.equal(entries.at(-1)?.status, "rejected");
});

test("durable audit is mandatory only for live exposure-increasing buys", () => {
  assert.equal(requiresDurableTradeAudit(true, "buy"), true);
  assert.equal(requiresDurableTradeAudit(true, "sell"), false);
  assert.equal(requiresDurableTradeAudit(false, "buy"), false);
  assert.equal(requiresDurableTradeAudit(false, "sell"), false);
});

test("paper trades do not depend on journal availability", async () => {
  const paperConfig = {
    SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    LIVE_TRADING: false,
    AUTO_BUY: false,
    BUY_AMOUNT_SOL: 0.01,
    MAX_BUYS_PER_SESSION: 1,
    MAX_SESSION_BUY_SOL: 0.05,
    MIN_SOL_RESERVE: 0.02,
    SLIPPAGE_PERCENT: 5,
    PRIORITY_FEE_SOL: 0.00005,
    MAX_TRADE_INTENT_AGE_MS: 10_000,
    TRADE_JOURNAL_ENABLED: true,
    TRADE_JOURNAL_PATH: "ignored.jsonl",
    DASHBOARD_EVENT_LOG_ENABLED: false,
    DASHBOARD_EVENT_LOG_PATH: "ignored-dashboard.jsonl",
    DASHBOARD_EVENT_QUEUE_CAPACITY: 1_000,
    DASHBOARD_API_HOST: "127.0.0.1" as const,
    DASHBOARD_API_PORT: 8_787,
    DASHBOARD_PROJECTION_STALE_AFTER_MS: 60_000,
    ALLOWED_PROGRAM_IDS: ["allowed-program"],
  } satisfies Config;

  await assert.doesNotReject(executeTrade(
    { action: "sell", mint: sellMint, amount: "100%", denominatedInSol: false },
    paperConfig,
    Keypair.generate(),
    new Connection(paperConfig.SOLANA_RPC_URL),
    async () => false,
  ));
});