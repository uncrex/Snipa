import assert from "node:assert/strict";
import { test } from "node:test";
import {
  journalTradeSafely,
  serializeTradeEntry,
  tradeJournalEntrySchema,
  type TradeJournalEntry,
} from "./journal.js";
import { PUMP_FEE_PROGRAM_ID, PUMP_SWAP_FEE_CONFIG_ADDRESS } from "./transaction-policy.js";

const entry: TradeJournalEntry = {
  timestamp: "2026-08-30T12:00:00.000Z",
  action: "buy",
  mint: "ExampleMint",
  amount: 0.01,
  denominatedInSol: true,
  mode: "PAPER",
  wallet: "ExampleWallet",
  signature: null,
};

test("serializeTradeEntry produces one structured JSONL record", () => {
  const serialized = serializeTradeEntry(entry);
  assert.equal(serialized.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(serialized), entry);
});

test("version 2 journal records remain readable without newer decision inputs", () => {
  assert.doesNotThrow(() => tradeJournalEntrySchema.parse({
    ...entry,
    schemaVersion: 2,
    decisionInputs: {
      slippagePercent: 5,
      buyAmountCapSol: 0.01,
      minSolReserve: 0.02,
      allowedProgramIds: ["legacy-program"],
    },
  }));
});

test("journaled PumpSwap reserve snapshots retain pinned decoder provenance", () => {
  const reserveSnapshot = {
    schemaVersion: 1,
    decoderVersion: "pumpswap-reserves-v1",
    eventId: "rpc-point-read:execution-rpc:123:11111111111111111111111111111111",
    kind: "reserve-updated",
    venue: "pumpswap",
    source: "execution-rpc",
    observedAt: "2026-08-30T12:00:00.000Z",
    slot: 123,
    writeVersion: 0,
    poolAddress: "11111111111111111111111111111111",
    baseMint: "So11111111111111111111111111111111111111112",
    quoteMint: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    baseReserveRaw: "1000000",
    quoteReserveRaw: "2000000",
  } as const;
  assert.doesNotThrow(() => tradeJournalEntrySchema.parse({
    ...entry,
    reserveSnapshots: [reserveSnapshot],
  }));
  assert.throws(() => tradeJournalEntrySchema.parse({
    ...entry,
    reserveSnapshots: [{ ...reserveSnapshot, decoderVersion: "pump-reserves-v1" }],
  }), /Unsupported reserve decoder/);
});

test("journaled PumpSwap trades preserve exact instruction semantics", () => {
  const identity = {
    poolAddress: "pool",
    baseMint: "base-mint",
    quoteMint: "quote-mint",
    poolBaseTokenAccount: "base-vault",
    poolQuoteTokenAccount: "quote-vault",
    globalConfigAddress: "global-config",
    feeConfigAddress: "fee-config",
    feeProgramAddress: "fee-program",
  };
  assert.doesNotThrow(() => tradeJournalEntrySchema.parse({
    ...entry,
    pumpswapTrades: [{
      ...identity,
      instructionName: "buy_exact_quote_in",
      inputSemantics: "exact-quote-input",
      exactQuoteInputRaw: "700",
      minBaseOutputRaw: "400",
    }],
  }));
  assert.throws(() => tradeJournalEntrySchema.parse({
    ...entry,
    pumpswapTrades: [{
      ...identity,
      instructionName: "buy_exact_quote_in",
      inputSemantics: "maximum-quote-input",
      exactQuoteInputRaw: "700",
      minBaseOutputRaw: "400",
    }],
  }));
});

test("journaled PumpSwap fee snapshots retain decoded schedule provenance", () => {
  assert.doesNotThrow(() => tradeJournalEntrySchema.parse({
    ...entry,
    pumpswapFeeConfigSnapshot: {
      schemaVersion: 1,
      decoderVersion: "pumpswap-fees-v1",
      eventId: `rpc-point-read:execution-rpc:123:${PUMP_SWAP_FEE_CONFIG_ADDRESS}`,
      source: "execution-rpc",
      observedAt: "2026-08-30T12:00:00.000Z",
      slot: 123,
      feeConfigAddress: PUMP_SWAP_FEE_CONFIG_ADDRESS,
      feeProgramAddress: PUMP_FEE_PROGRAM_ID,
      bump: 254,
      admin: "admin",
      flatFees: { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 5 },
      feeTiers: [],
      stableFeeTiers: [],
    },
  }));
});

test("journalTradeSafely contains writer failures", async () => {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const written = await journalTradeSafely("ignored.jsonl", entry, async () => {
      throw new Error("disk unavailable");
    });
    assert.equal(written, false);
  } finally {
    console.error = originalError;
  }
});