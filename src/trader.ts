import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { withLiveBuyFileLock } from "./execution-lock.js";
import { readTradeJournalState } from "./history.js";
import { journalTradeSafely, type TradeJournalEntry } from "./journal.js";
import { assertLiveTradingArmed } from "./live-safety.js";
import {
  decodePumpswapFeeConfigSnapshotFromAccounts,
  type PumpswapFeeConfigSnapshot,
} from "./pumpswap-fees.js";
import {
  decodePumpswapReserveSnapshots,
  decodePumpswapSimulationVaultBalances,
  type ReserveSnapshot,
} from "./reserve-snapshots.js";
import {
  assertTransactionPolicyDetails,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  type PumpswapTradeAccounts,
} from "./transaction-policy.js";

export type TradeAction = "buy" | "sell";

export interface TradeRequest {
  action: TradeAction;
  mint: string;
  amount: number | string;
  denominatedInSol: boolean;
}

export interface BuyMintSafetySnapshot {
  tokenProgram: typeof SPL_TOKEN_PROGRAM_ID;
  decimals: number;
  supplyRaw: string;
  mintAuthority: null;
  freezeAuthority: null;
}

export function assertSafeBuyMintAccount(input: unknown): BuyMintSafetySnapshot {
  if (input === null) throw new Error("Buy mint account does not exist.");
  if (typeof input !== "object" || input === null
    || !("owner" in input) || !(input.owner instanceof PublicKey)
    || !("executable" in input) || typeof input.executable !== "boolean"
    || !("data" in input) || !Buffer.isBuffer(input.data)) {
    throw new Error("Buy mint RPC account response is malformed.");
  }
  const { owner, executable, data } = input;
  const ownerProgram = owner.toBase58();
  if (ownerProgram === TOKEN_2022_PROGRAM_ID) {
    throw new Error("Token-2022 mint is not eligible for live buys.");
  }
  if (ownerProgram !== SPL_TOKEN_PROGRAM_ID) {
    throw new Error(`Buy mint owner ${ownerProgram} is not the classic SPL Token program.`);
  }
  if (executable || data.length !== 82) {
    throw new Error("Buy mint is not a supported classic 82-byte SPL Token mint.");
  }
  const mintAuthorityOption = data.readUInt32LE(0);
  const freezeAuthorityOption = data.readUInt32LE(46);
  if (mintAuthorityOption !== 0 && mintAuthorityOption !== 1) {
    throw new Error("Buy mint has an invalid mint authority option tag.");
  }
  if (freezeAuthorityOption !== 0 && freezeAuthorityOption !== 1) {
    throw new Error("Buy mint has an invalid freeze authority option tag.");
  }
  if (mintAuthorityOption === 1) throw new Error("Buy mint still has an active mint authority.");
  if (freezeAuthorityOption === 1) throw new Error("Buy mint still has an active freeze authority.");
  const supply = data.readBigUInt64LE(36);
  const decimals = data.readUInt8(44);
  if (data.readUInt8(45) !== 1) throw new Error("Buy mint is not initialized.");
  if (supply === 0n) throw new Error("Buy mint has zero supply.");
  return {
    tokenProgram: SPL_TOKEN_PROGRAM_ID,
    decimals,
    supplyRaw: supply.toString(),
    mintAuthority: null,
    freezeAuthority: null,
  };
}

function tokenAmountToRawUnits(amount: number, decimals: number): bigint {
  const numericText = amount.toString().toLowerCase();
  const [coefficient, exponentText] = numericText.split("e");
  let text = coefficient ?? numericText;
  if (exponentText !== undefined) {
    const exponent = Number(exponentText);
    const [whole = "0", fraction = ""] = text.split(".");
    const digits = `${whole}${fraction}`;
    const decimalIndex = whole.length + exponent;
    text = decimalIndex <= 0
      ? `0.${"0".repeat(-decimalIndex)}${digits}`
      : decimalIndex >= digits.length
        ? `${digits}${"0".repeat(decimalIndex - digits.length)}`
        : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error("Numeric sell amount cannot be represented as token units.");
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`Sell amount has more precision than the token supports (${decimals} decimals).`);
  }
  return BigInt(`${match[1]}${fraction.padEnd(decimals, "0")}`);
}

function assertCOptionTag(data: Buffer, offset: number, field: string): void {
  const tag = data.readUInt32LE(offset);
  if (tag !== 0 && tag !== 1) {
    throw new Error(`Classic SPL account has an invalid ${field} option tag.`);
  }
}

export function assertClassicSellMintDecimals(input: unknown): number {
  if (input === null) throw new Error("Sell mint account does not exist.");
  if (typeof input !== "object" || input === null
    || !("owner" in input) || !(input.owner instanceof PublicKey)
    || !("executable" in input) || typeof input.executable !== "boolean"
    || !("data" in input) || !Buffer.isBuffer(input.data)) {
    throw new Error("Sell mint RPC account response is malformed.");
  }
  const { owner, executable, data } = input;
  if (owner.toBase58() === TOKEN_2022_PROGRAM_ID) {
    throw new Error("Token-2022 numeric sells are not supported.");
  }
  if (owner.toBase58() !== SPL_TOKEN_PROGRAM_ID || executable || data.length !== 82) {
    throw new Error("Sell mint is not a supported classic 82-byte SPL Token mint.");
  }
  assertCOptionTag(data, 0, "mint authority");
  assertCOptionTag(data, 46, "freeze authority");
  if (data.readUInt8(45) !== 1) throw new Error("Sell mint is not initialized.");
  return data.readUInt8(44);
}

export function assertSpendableSellTokenAccount(
  input: unknown,
  sellAmount: number | string,
  expectedMint: string,
  expectedOwner: string,
  mintDecimals?: number,
): bigint {
  if (!Array.isArray(input)) throw new Error("Sell token account response is malformed.");
  if (typeof sellAmount === "number"
    && (!Number.isInteger(mintDecimals) || mintDecimals === undefined
      || mintDecimals < 0 || mintDecimals > 255)) {
    throw new Error("Numeric sell preflight requires decoded mint decimals between 0 and 255.");
  }
  const accounts = input;
  if (accounts.length === 0) {
    throw new Error("Wallet has no token account for the requested sell mint.");
  }
  let hasFrozenBalance = false;
  let spendableRawBalance = 0n;
  for (const item of accounts) {
    if (typeof item !== "object" || item === null
      || !("account" in item) || typeof item.account !== "object" || item.account === null
      || !("owner" in item.account) || !(item.account.owner instanceof PublicKey)
      || !("executable" in item.account) || typeof item.account.executable !== "boolean"
      || !("data" in item.account) || !Buffer.isBuffer(item.account.data)) {
      throw new Error("Sell token account response is malformed.");
    }
    const { owner: programOwner, executable, data } = item.account;
    if (programOwner.toBase58() !== SPL_TOKEN_PROGRAM_ID || executable || data.length !== 165) {
      throw new Error("Sell token account is not a supported classic 165-byte SPL Token account.");
    }
    assertCOptionTag(data, 72, "delegate");
    assertCOptionTag(data, 109, "native account");
    assertCOptionTag(data, 129, "close authority");
    const mint = new PublicKey(data.subarray(0, 32)).toBase58();
    const owner = new PublicKey(data.subarray(32, 64)).toBase58();
    if (mint !== expectedMint) throw new Error("RPC returned a token account for an unexpected mint.");
    if (owner !== expectedOwner) throw new Error("RPC returned a token account for an unexpected owner.");
    const amountRaw = data.readBigUInt64LE(64);
    const state = data.readUInt8(108);
    if (state !== 1 && state !== 2) throw new Error("Sell token account is not initialized.");
    if (amountRaw === 0n) continue;
    if (state === 2) {
      hasFrozenBalance = true;
      continue;
    }
    spendableRawBalance += amountRaw;
  }
  if (spendableRawBalance > 0n) {
    const requestedRawAmount = typeof sellAmount === "string"
      ? spendableRawBalance * BigInt(Number.parseInt(sellAmount, 10)) / 100n
      : tokenAmountToRawUnits(sellAmount, mintDecimals!);
    if (requestedRawAmount === 0n) {
      throw new Error("Sell amount rounds down to zero raw token units.");
    }
    if (spendableRawBalance >= requestedRawAmount) return requestedRawAmount;
    throw new Error(
      `Insufficient token balance: ${spendableRawBalance} raw units available, ${requestedRawAmount} required.`,
    );
  }
  if (hasFrozenBalance) {
    throw new Error("Wallet token balance for the requested sell mint is frozen.");
  }
  throw new Error("Wallet token balance for the requested sell mint is zero.");
}

export function requiredBuyBalance(
  amountSol: number,
  priorityFeeSol: number,
  reserveSol: number,
): number {
  return amountSol + priorityFeeSol + reserveSol;
}

export function maxBuySpendLamports(amountSol: number, slippagePercent: number): bigint {
  return BigInt(Math.ceil(amountSol * LAMPORTS_PER_SOL * (1 + slippagePercent / 100)));
}

export function maxBuySpendSol(amountSol: number, slippagePercent: number): number {
  return Number(maxBuySpendLamports(amountSol, slippagePercent)) / LAMPORTS_PER_SOL;
}

export function computeUnitUtilizationBps(unitsConsumed: number, computeUnitLimit: number): number {
  if (!Number.isSafeInteger(unitsConsumed) || unitsConsumed < 0) {
    throw new Error("Simulation units consumed must be a nonnegative safe integer.");
  }
  if (!Number.isSafeInteger(computeUnitLimit) || computeUnitLimit <= 0) {
    throw new Error("Compute unit limit must be a positive safe integer.");
  }
  if (unitsConsumed > computeUnitLimit) {
    throw new Error(
      `Simulation consumed ${unitsConsumed} compute units above declared limit ${computeUnitLimit}.`,
    );
  }
  return Math.ceil(unitsConsumed * 10_000 / computeUnitLimit);
}

export function requireSimulationComputeUnits(
  unitsConsumed: number | null,
  computeUnitLimit: number,
  required: boolean,
): number | null {
  if (unitsConsumed === null) {
    if (required) throw new Error("Live buy simulation did not report compute units consumed.");
    return null;
  }
  return computeUnitUtilizationBps(unitsConsumed, computeUnitLimit);
}

export function pumpswapSimulationAccountConfig(
  trades: readonly PumpswapTradeAccounts[],
): { encoding: "base64"; addresses: string[] } | undefined {
  const addresses = [...new Set(trades.flatMap((trade) => [
    trade.poolBaseTokenAccount,
    trade.poolQuoteTokenAccount,
  ]))];
  return addresses.length === 0 ? undefined : { encoding: "base64", addresses };
}

export function pumpswapPointReadAddresses(
  trades: readonly (PumpswapTradeAccounts & { feeConfigAddress: string })[],
): string[] | undefined {
  const simulationConfig = pumpswapSimulationAccountConfig(trades);
  if (!simulationConfig) return undefined;
  return [...new Set([
    ...simulationConfig.addresses,
    ...trades.map((trade) => trade.feeConfigAddress),
  ])];
}

export function assertComputeHeadroom(
  utilizationBps: number,
  minimumHeadroomBps: number | undefined,
  required: boolean,
): void {
  if (!required || minimumHeadroomBps === undefined) return;
  if (!Number.isSafeInteger(minimumHeadroomBps)
    || minimumHeadroomBps <= 0
    || minimumHeadroomBps >= 10_000) {
    throw new Error("Minimum compute headroom must be between 1 and 9999 basis points.");
  }
  const availableHeadroomBps = 10_000 - utilizationBps;
  if (availableHeadroomBps < minimumHeadroomBps) {
    throw new Error(
      `Live buy compute headroom ${availableHeadroomBps} bps is below required ${minimumHeadroomBps} bps.`,
    );
  }
}

export function assertTransactionSucceeded(error: unknown): void {
  if (error) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(error)}`);
  }
}

export function requiresDurableTradeAudit(liveTrading: boolean, action: TradeAction): boolean {
  return liveTrading && action === "buy";
}

let liveBuyQueue: Promise<void> = Promise.resolve();

export async function serializeLiveBuy<T>(
  required: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  if (!required) return operation();
  const predecessor = liveBuyQueue;
  let release: () => void = () => undefined;
  liveBuyQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
  }
}

export type SubmissionResolution = "confirmed" | "failed" | "unresolved";

export function classifySubmissionStatus(status: {
  err: unknown;
  confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
} | null): SubmissionResolution {
  if (!status) return "unresolved";
  if (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized") {
    return "unresolved";
  }
  return status.err === null ? "confirmed" : "failed";
}

export async function reconcileUnresolvedSubmissions(
  entries: TradeJournalEntry[],
  connection: Pick<Connection, "getSignatureStatuses">,
  journalPath: string,
  journal: typeof journalTradeSafely = journalTradeSafely,
): Promise<TradeJournalEntry[]> {
  if (entries.length === 0) return [];
  const signatures = entries.map((entry) => {
    if (!entry.signature) throw new Error("Unresolved submission is missing its signature.");
    return entry.signature;
  });
  const response = await connection.getSignatureStatuses(signatures, {
    searchTransactionHistory: true,
  });
  const unresolved: TradeJournalEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const status = response.value[index] ?? null;
    const resolution = classifySubmissionStatus(status);
    if (resolution === "unresolved") {
      unresolved.push(entry);
      continue;
    }
    const finalizedAt = new Date().toISOString();
    const error = status?.err ?? null;
    const terminalEntry: TradeJournalEntry = {
      ...entry,
      timestamp: finalizedAt,
      finalizedAt,
      status: resolution,
      rejectionReason: resolution === "failed"
        ? `Transaction failed on-chain: ${JSON.stringify(error)}`
        : null,
    };
    if (!await journal(journalPath, terminalEntry)) {
      throw new Error(
        `Live buy blocked because trade journal reconciliation failed for ${entry.signature}.`,
      );
    }
  }
  return unresolved;
}

export async function assertRecentBlockhashValid(
  connection: Pick<Connection, "isBlockhashValid">,
  blockhash: string,
  stage: string,
): Promise<void> {
  let valid: boolean;
  try {
    valid = (await connection.isBlockhashValid(blockhash, { commitment: "confirmed" })).value;
  } catch (error) {
    throw new Error(
      `Cannot verify transaction blockhash before ${stage}: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!valid) {
    throw new Error(`Transaction blockhash expired before ${stage}.`);
  }
}

export interface TransactionBlockhashLease {
  blockhash: string;
  lastValidBlockHeight: number;
}

export async function refreshTransactionBlockhash(
  connection: Pick<Connection, "getLatestBlockhash">,
  transaction: VersionedTransaction,
): Promise<TransactionBlockhashLease> {
  let lease: TransactionBlockhashLease;
  try {
    lease = await connection.getLatestBlockhash("confirmed");
  } catch (error) {
    throw new Error(
      `Cannot refresh transaction blockhash: ${error instanceof Error ? error.message : error}`,
    );
  }
  transaction.message.recentBlockhash = lease.blockhash;
  transaction.signatures = transaction.signatures.map(() => new Uint8Array(64));
  return lease;
}

export function assertTradeIntentFresh(
  candidateAt: string,
  maxAgeMs: number,
  stage: string,
  nowMs = Date.now(),
): void {
  const candidateAtMs = Date.parse(candidateAt);
  if (!Number.isFinite(candidateAtMs)) throw new Error("Trade candidate timestamp is invalid.");
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error("Maximum trade intent age must be a positive safe integer.");
  }
  const ageMs = nowMs - candidateAtMs;
  if (ageMs < 0) throw new Error("Trade candidate timestamp is in the future.");
  if (ageMs > maxAgeMs) {
    throw new Error(`Trade intent expired before ${stage}: age ${ageMs}ms exceeds ${maxAgeMs}ms.`);
  }
}

function validateTrade(request: TradeRequest, config: Config): void {
  new PublicKey(request.mint);
  if (request.action === "buy") {
    if (!request.denominatedInSol || typeof request.amount !== "number") {
      throw new Error("Buy amounts must be numeric and denominated in SOL.");
    }
    if (request.amount > config.BUY_AMOUNT_SOL) {
      throw new Error(`Buy exceeds BUY_AMOUNT_SOL safety cap (${config.BUY_AMOUNT_SOL} SOL).`);
    }
  }
  if (request.action === "sell" && typeof request.amount === "string") {
    if (!/^(100|[1-9]\d?)%$/.test(request.amount)) {
      throw new Error("Sell percentage must be between 1% and 100%.");
    }
  }
  if (request.action === "sell" && typeof request.amount === "number") {
    if (!Number.isFinite(request.amount) || request.amount <= 0) {
      throw new Error("Sell token amount must be a positive finite number.");
    }
  }
  if (request.action === "sell" && request.denominatedInSol) {
    throw new Error("Sell amounts must be denominated in tokens or a percentage.");
  }
}

export async function executeTrade(
  request: TradeRequest,
  config: Config,
  wallet: Keypair,
  connection: Connection,
  journal: typeof journalTradeSafely = journalTradeSafely,
  journalStateReader: typeof readTradeJournalState = readTradeJournalState,
): Promise<string | undefined> {
  const candidateAt = new Date().toISOString();
  const requiresExclusiveExecution = requiresDurableTradeAudit(
    config.LIVE_TRADING,
    request.action,
  );
  return serializeLiveBuy(requiresExclusiveExecution, () => {
    const execute = () => executeTradeSerialized(
      request,
      config,
      wallet,
      connection,
      journal,
      journalStateReader,
      candidateAt,
    );
    return requiresExclusiveExecution
      ? withLiveBuyFileLock(config.TRADE_JOURNAL_PATH, execute)
      : execute();
  });
}

async function executeTradeSerialized(
  request: TradeRequest,
  config: Config,
  wallet: Keypair,
  connection: Connection,
  journal: typeof journalTradeSafely,
  journalStateReader: typeof readTradeJournalState,
  candidateAt: string,
): Promise<string | undefined> {
  const mode = config.LIVE_TRADING ? "LIVE" : "PAPER";
  const journalEntry: TradeJournalEntry = {
    schemaVersion: 2,
    decisionId: randomUUID(),
    timestamp: candidateAt,
    candidateAt,
    decisionAt: null,
    simulationAt: null,
    submittedAt: null,
    finalizedAt: null,
    action: request.action,
    mint: request.mint,
    amount: request.amount,
    denominatedInSol: request.denominatedInSol,
    mode,
    wallet: wallet.publicKey.toBase58(),
    signature: null,
    status: "candidate",
    rejectionReason: null,
    route: "pumpportal:auto",
    expectedOutput: null,
    fees: {
      priorityFeeSol: config.PRIORITY_FEE_SOL,
      maxPriorityFeeLamports: String(Math.ceil(config.PRIORITY_FEE_SOL * LAMPORTS_PER_SOL)),
    },
    decisionInputs: {
      slippagePercent: config.SLIPPAGE_PERCENT,
      buyAmountCapSol: config.BUY_AMOUNT_SOL,
      minSolReserve: config.MIN_SOL_RESERVE,
      allowedProgramIds: [...config.ALLOWED_PROGRAM_IDS],
      maxSellAmountRaw: null,
      maxTradeIntentAgeMs: config.MAX_TRADE_INTENT_AGE_MS,
      minComputeHeadroomBps: config.MIN_COMPUTE_HEADROOM_BPS,
    },
    simulation: null,
    submission: null,
  };
  let latestJournalEntry = journalEntry;
  const requiresDurablePreBroadcastAudit = requiresDurableTradeAudit(
    config.LIVE_TRADING,
    request.action,
  );
  const writeJournal = async (
    entry: TradeJournalEntry,
    required: boolean,
  ): Promise<void> => {
    if (!config.TRADE_JOURNAL_ENABLED) {
      if (required) {
        throw new Error("Live buys require TRADE_JOURNAL_ENABLED=true.");
      }
      return;
    }
    const written = await journal(config.TRADE_JOURNAL_PATH, entry);
    if (!written && required) {
      throw new Error(`Live buy blocked because trade journal append failed at ${entry.status}.`);
    }
  };
  const record = async (
    status: NonNullable<TradeJournalEntry["status"]>,
    updates: Partial<TradeJournalEntry> = {},
    requireDurableAudit = false,
  ): Promise<void> => {
    latestJournalEntry = {
      ...latestJournalEntry,
      ...updates,
      timestamp: new Date().toISOString(),
      status,
    };
    await writeJournal(latestJournalEntry, requireDurableAudit);
  };

  try {
    if (requiresDurablePreBroadcastAudit) {
      const journalState = await journalStateReader(config.TRADE_JOURNAL_PATH);
      if (journalState.invalidLines > 0) {
        throw new Error(
          `Live buy blocked because the trade journal contains ${journalState.invalidLines} invalid line(s).`,
        );
      }
      const [unresolved] = await reconcileUnresolvedSubmissions(
        journalState.unresolvedSubmissions,
        connection,
        config.TRADE_JOURNAL_PATH,
        journal,
      );
      if (unresolved) {
        throw new Error(
          `Live buy blocked by unresolved submission ${unresolved.signature} for decision ${unresolved.decisionId}.`,
        );
      }
    }
    await writeJournal(journalEntry, requiresDurablePreBroadcastAudit);
    validateTrade(request, config);
    return await executeValidatedTrade(
      request,
      config,
      wallet,
      connection,
      record,
      requiresDurablePreBroadcastAudit,
      candidateAt,
    );
  } catch (error) {
    if (!latestJournalEntry.signature) {
      await record("rejected", {
        finalizedAt: new Date().toISOString(),
        rejectionReason: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

async function executeValidatedTrade(
  request: TradeRequest,
  config: Config,
  wallet: Keypair,
  connection: Connection,
  record: (
    status: NonNullable<TradeJournalEntry["status"]>,
    updates?: Partial<TradeJournalEntry>,
    requireDurableAudit?: boolean,
  ) => Promise<void>,
  requiresDurablePreBroadcastAudit: boolean,
  candidateAt: string,
): Promise<string | undefined> {
  const mode = config.LIVE_TRADING ? "LIVE" : "PAPER";
  console.log(`[${mode}] ${request.action} ${request.amount} ${request.denominatedInSol ? "SOL" : "tokens"} of ${request.mint}`);
  if (!config.LIVE_TRADING) {
    const finalizedAt = new Date().toISOString();
    await record("paper", { decisionAt: finalizedAt, finalizedAt });
    return undefined;
  }

  await assertLiveTradingArmed(config.LIVE_TRADING, config.LIVE_TRADING_ARM_PATH);
  let maxSellAmountRaw: bigint | undefined;
  if (request.action === "buy" && typeof request.amount === "number") {
    const mintAccount = await connection.getAccountInfo(
      new PublicKey(request.mint),
      "confirmed",
    );
    const assetValidation = assertSafeBuyMintAccount(mintAccount);
    await record("asset-validated", { assetValidation }, requiresDurablePreBroadcastAudit);
    const maxSpendSol = maxBuySpendSol(request.amount, config.SLIPPAGE_PERCENT);
    const balanceSol = await connection.getBalance(wallet.publicKey) / LAMPORTS_PER_SOL;
    const requiredSol = requiredBuyBalance(
      maxSpendSol,
      config.PRIORITY_FEE_SOL,
      config.MIN_SOL_RESERVE,
    );
    if (balanceSol < requiredSol) {
      throw new Error(
        `Insufficient SOL: ${balanceSol} available, ${requiredSol} required including reserve.`,
      );
    }
  }
  if (request.action === "sell") {
    const accounts = await connection.getTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(request.mint),
    });
    const mintDecimals = typeof request.amount === "number"
      ? assertClassicSellMintDecimals(await connection.getAccountInfo(
        new PublicKey(request.mint),
        "confirmed",
      ))
      : undefined;
    maxSellAmountRaw = assertSpendableSellTokenAccount(
      accounts.value,
      request.amount,
      request.mint,
      wallet.publicKey.toBase58(),
      mintDecimals,
    );
  }

  assertTradeIntentFresh(candidateAt, config.MAX_TRADE_INTENT_AGE_MS, "route request");
  await assertLiveTradingArmed(config.LIVE_TRADING, config.LIVE_TRADING_ARM_PATH);
  const response = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: wallet.publicKey.toBase58(),
      action: request.action,
      mint: request.mint,
      amount: request.amount,
      denominatedInSol: String(request.denominatedInSol),
      slippage: config.SLIPPAGE_PERCENT,
      priorityFee: config.PRIORITY_FEE_SOL,
      pool: "auto",
    }),
  });
  if (!response.ok) {
    throw new Error(`PumpPortal rejected the trade (${response.status}): ${await response.text()}`);
  }

  const transaction = VersionedTransaction.deserialize(new Uint8Array(await response.arrayBuffer()));
  const mint = new PublicKey(request.mint);
  const maxPriorityFeeLamports = BigInt(Math.ceil(config.PRIORITY_FEE_SOL * LAMPORTS_PER_SOL));
  const policyContext = request.action === "buy" && typeof request.amount === "number"
    ? {
        action: request.action,
        mint,
        maxSpendLamports: maxBuySpendLamports(request.amount, config.SLIPPAGE_PERCENT),
        maxPriorityFeeLamports,
      } as const
    : {
        action: "sell",
        mint,
        maxSellAmountRaw: maxSellAmountRaw ?? 0n,
        maxPriorityFeeLamports,
      } as const;
  const policyDetails = await assertTransactionPolicyDetails(
    transaction,
    wallet.publicKey,
    config.ALLOWED_PROGRAM_IDS,
    connection,
    policyContext,
  );
  const pumpswapAccounts = pumpswapSimulationAccountConfig(policyDetails.pumpswapTrades);
  let reserveSnapshots: ReserveSnapshot[] | undefined;
  let pumpswapFeeConfigSnapshot: PumpswapFeeConfigSnapshot | undefined;
  if (pumpswapAccounts) {
    const pointReadAddresses = pumpswapPointReadAddresses(policyDetails.pumpswapTrades);
    if (!pointReadAddresses) throw new Error("PumpSwap point-read addresses are unavailable.");
    const reserveRead = await connection.getMultipleAccountsInfoAndContext(
      pointReadAddresses.map((address) => new PublicKey(address)),
      { commitment: "confirmed" },
    );
    const observedAt = new Date().toISOString();
    reserveSnapshots = decodePumpswapReserveSnapshots(
      policyDetails.pumpswapTrades,
      pointReadAddresses,
      reserveRead.value,
      reserveRead.context.slot,
      "execution-rpc",
      observedAt,
    );
    pumpswapFeeConfigSnapshot = decodePumpswapFeeConfigSnapshotFromAccounts(
      pointReadAddresses,
      reserveRead.value,
      reserveRead.context.slot,
      "execution-rpc",
      observedAt,
    );
  }
  const blockhashLease = await refreshTransactionBlockhash(connection, transaction);
  await assertRecentBlockhashValid(
    connection,
    blockhashLease.blockhash,
    "signing",
  );
  await record("policy-approved", {
    decisionAt: new Date().toISOString(),
    ...(reserveSnapshots ? { reserveSnapshots } : {}),
    ...(pumpswapFeeConfigSnapshot ? { pumpswapFeeConfigSnapshot } : {}),
    ...(policyDetails.pumpswapTrades.length > 0 ? {
      pumpswapTrades: policyDetails.pumpswapTrades.map((trade) => {
        const identity = {
          poolAddress: trade.poolAddress,
          baseMint: trade.baseMint,
          quoteMint: trade.quoteMint,
          poolBaseTokenAccount: trade.poolBaseTokenAccount,
          poolQuoteTokenAccount: trade.poolQuoteTokenAccount,
          globalConfigAddress: trade.globalConfigAddress,
          feeConfigAddress: trade.feeConfigAddress,
          feeProgramAddress: trade.feeProgramAddress,
        };
        switch (trade.instructionName) {
          case "buy": return {
            ...identity,
            instructionName: trade.instructionName,
            inputSemantics: trade.inputSemantics,
            exactBaseOutputRaw: trade.exactBaseOutputRaw.toString(),
            maxQuoteInputRaw: trade.maxQuoteInputRaw.toString(),
          };
          case "buy_exact_quote_in": return {
            ...identity,
            instructionName: trade.instructionName,
            inputSemantics: trade.inputSemantics,
            exactQuoteInputRaw: trade.exactQuoteInputRaw.toString(),
            minBaseOutputRaw: trade.minBaseOutputRaw.toString(),
          };
          case "sell": return {
            ...identity,
            instructionName: trade.instructionName,
            inputSemantics: trade.inputSemantics,
            exactBaseInputRaw: trade.exactBaseInputRaw.toString(),
            minQuoteOutputRaw: trade.minQuoteOutputRaw.toString(),
          };
        }
      }),
    } : {}),
    fees: {
      priorityFeeSol: config.PRIORITY_FEE_SOL,
      maxPriorityFeeLamports: maxPriorityFeeLamports.toString(),
      computeUnitLimit: policyDetails.computeUnitLimit,
      computeUnitPriceMicroLamports: policyDetails.computeUnitPriceMicroLamports.toString(),
      transactionPriorityFeeLamports: policyDetails.maxPriorityFeeLamports.toString(),
    },
    decisionInputs: {
      slippagePercent: config.SLIPPAGE_PERCENT,
      buyAmountCapSol: config.BUY_AMOUNT_SOL,
      minSolReserve: config.MIN_SOL_RESERVE,
      allowedProgramIds: [...config.ALLOWED_PROGRAM_IDS],
      maxSellAmountRaw: maxSellAmountRaw?.toString() ?? null,
      maxTradeIntentAgeMs: config.MAX_TRADE_INTENT_AGE_MS,
      minComputeHeadroomBps: config.MIN_COMPUTE_HEADROOM_BPS,
    },
  }, requiresDurablePreBroadcastAudit);
  assertTradeIntentFresh(candidateAt, config.MAX_TRADE_INTENT_AGE_MS, "signing");
  await assertLiveTradingArmed(config.LIVE_TRADING, config.LIVE_TRADING_ARM_PATH);
  transaction.sign([wallet]);
  const simulationAccounts = pumpswapAccounts;
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    ...(simulationAccounts ? { accounts: simulationAccounts } : {}),
  });
  const unitsConsumed = simulation.value.unitsConsumed ?? null;
  let pumpswapVaultBalances: ReturnType<typeof decodePumpswapSimulationVaultBalances>[] | undefined;
  let pumpswapVaultError: unknown;
  if (simulationAccounts) {
    try {
      pumpswapVaultBalances = policyDetails.pumpswapTrades.map((trade) =>
        decodePumpswapSimulationVaultBalances(
          trade,
          simulationAccounts.addresses,
          simulation.value.accounts,
        ));
    } catch (error) {
      pumpswapVaultError = error;
    }
  }
  let computeUnitUtilization: number | null = null;
  let computeMetadataError: unknown;
  try {
    computeUnitUtilization = requireSimulationComputeUnits(
      unitsConsumed,
      policyDetails.computeUnitLimit,
      requiresDurablePreBroadcastAudit,
    );
  } catch (error) {
    computeMetadataError = error;
  }
  await record("simulation-completed", {
    simulationAt: new Date().toISOString(),
    simulation: {
      error: simulation.value.err,
      unitsConsumed,
      computeUnitUtilizationBps: computeUnitUtilization,
      ...(simulationAccounts ? { pumpswapVaultBalances: pumpswapVaultBalances ?? null } : {}),
    },
  }, requiresDurablePreBroadcastAudit);
  if (simulation.value.err) {
    throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  if (pumpswapVaultError) throw pumpswapVaultError;
  if (computeMetadataError) throw computeMetadataError;
  if (computeUnitUtilization !== null) {
    assertComputeHeadroom(
      computeUnitUtilization,
      config.MIN_COMPUTE_HEADROOM_BPS,
      requiresDurablePreBroadcastAudit,
    );
  }

  assertTradeIntentFresh(candidateAt, config.MAX_TRADE_INTENT_AGE_MS, "broadcast");
  await assertLiveTradingArmed(config.LIVE_TRADING, config.LIVE_TRADING_ARM_PATH);
  await assertRecentBlockhashValid(
    connection,
    blockhashLease.blockhash,
    "broadcast",
  );
  const signatureBytes = transaction.signatures[0];
  if (!signatureBytes || signatureBytes.every((byte) => byte === 0)) {
    throw new Error("Signed transaction does not contain the wallet signature.");
  }
  const expectedSignature = bs58.encode(signatureBytes);
  await record("submitted", {
    submittedAt: new Date().toISOString(),
    signature: expectedSignature,
    submission: {
      signature: expectedSignature,
      blockhash: blockhashLease.blockhash,
      lastValidBlockHeight: blockhashLease.lastValidBlockHeight,
    },
  }, requiresDurablePreBroadcastAudit);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 3,
    preflightCommitment: "confirmed",
    skipPreflight: false,
  });
  if (signature !== expectedSignature) {
    throw new Error(
      `RPC returned signature ${signature}, expected signed transaction ${expectedSignature}.`,
    );
  }
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash: blockhashLease.blockhash,
    lastValidBlockHeight: blockhashLease.lastValidBlockHeight,
  }, "confirmed");
  if (confirmation.value.err) {
    const failure = `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`;
    await record("failed", {
      finalizedAt: new Date().toISOString(),
      rejectionReason: failure,
    });
    throw new Error(failure);
  }
  await record("confirmed", { finalizedAt: new Date().toISOString() });
  return signature;
}