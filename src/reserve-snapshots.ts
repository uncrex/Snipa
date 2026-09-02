import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import {
  SPL_TOKEN_PROGRAM_ID,
  type PumpswapTradeAccounts,
} from "./transaction-policy.js";

const publicKeySchema = z.string().refine((value) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid Solana public key");

export const PINNED_RESERVE_DECODER_VERSIONS = Object.freeze({
  pump: "pump-reserves-v1",
  pumpswap: "pumpswap-reserves-v1",
} as const);

export const reserveSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  decoderVersion: z.string().regex(/^[a-z0-9-]+-v\d+$/),
  eventId: z.string().min(1),
  kind: z.literal("reserve-updated"),
  venue: z.enum([
    "pump",
    "pumpswap",
    "raydium-cpmm",
    "raydium-clmm",
    "raydium-launchlab",
    "meteora-dlmm",
    "meteora-damm",
    "meteora-dbc",
  ]),
  source: z.string().min(1),
  observedAt: z.string().datetime(),
  slot: z.number().int().nonnegative().safe(),
  writeVersion: z.number().int().nonnegative().safe(),
  poolAddress: publicKeySchema,
  baseMint: publicKeySchema,
  quoteMint: publicKeySchema,
  baseReserveRaw: z.string().regex(/^\d+$/),
  quoteReserveRaw: z.string().regex(/^\d+$/),
}).superRefine((snapshot, context) => {
  const supportedVersion = PINNED_RESERVE_DECODER_VERSIONS[
    snapshot.venue as keyof typeof PINNED_RESERVE_DECODER_VERSIONS
  ];
  if (supportedVersion === undefined) {
    context.addIssue({
      code: "custom",
      path: ["venue"],
      message: `No trusted reserve decoder is implemented for venue ${snapshot.venue}`,
    });
    return;
  }
  if (snapshot.decoderVersion !== supportedVersion) {
    context.addIssue({
      code: "custom",
      path: ["decoderVersion"],
      message: `Unsupported reserve decoder ${snapshot.decoderVersion} for venue ${snapshot.venue}`,
    });
  }
});

export type ReserveSnapshot = z.infer<typeof reserveSnapshotSchema>;

export interface PumpswapExactInputQuote {
  modelVersion: "pumpswap-constant-product-v1";
  reserveEventId: string;
  decoderVersion: string;
  poolAddress: string;
  source: string;
  observedAt: string;
  slot: number;
  writeVersion: number;
  baseMint: string;
  quoteMint: string;
  inputSide: "base" | "quote";
  inputAmountRaw: string;
  feeBps: number;
  maxPriceImpactBps: number;
  feeAmountRaw: string;
  effectiveInputAmountRaw: string;
  outputAmountRaw: string;
  priceImpactBps: number;
  postBaseReserveRaw: string;
  postQuoteReserveRaw: string;
  invariantBeforeRaw: string;
  invariantAfterRaw: string;
}

const pumpswapSimulationObservationSchema = z.object({
  poolAddress: publicKeySchema,
  baseMint: publicKeySchema,
  quoteMint: publicKeySchema,
  inputSide: z.enum(["base", "quote"]),
  slot: z.number().int().nonnegative().safe(),
  effectiveInputAmountRaw: z.string().regex(/^\d+$/),
  outputAmountRaw: z.string().regex(/^\d+$/),
  postBaseReserveRaw: z.string().regex(/^\d+$/),
  postQuoteReserveRaw: z.string().regex(/^\d+$/),
});

export type PumpswapSimulationObservation = z.infer<typeof pumpswapSimulationObservationSchema>;

export interface PumpswapSimulationAgreement {
  quoteSlot: number;
  simulationSlot: number;
  slotSkew: number;
  maxDivergenceBps: number;
  divergenceBps: {
    effectiveInputAmount: number;
    outputAmount: number;
    postBaseReserve: number;
    postQuoteReserve: number;
  };
}

export interface PumpswapSimulationVaultBalances {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  postBaseReserveRaw: string;
  postQuoteReserveRaw: string;
}

interface RpcTokenAccountInfo {
  owner: PublicKey;
  executable: boolean;
  data: Buffer;
}

function decodeRpcTokenAmount(
  input: unknown,
  expectedMint: string,
  accountName: string,
): string {
  if (typeof input !== "object" || input === null
    || !("owner" in input) || !(input.owner instanceof PublicKey)
    || input.owner.toBase58() !== SPL_TOKEN_PROGRAM_ID
    || !("executable" in input) || input.executable !== false
    || !("data" in input) || !Buffer.isBuffer(input.data)) {
    throw new Error(`PumpSwap ${accountName} RPC account is malformed or not classic SPL Token data.`);
  }
  const account = input as RpcTokenAccountInfo;
  if (account.data.length !== 165) {
    throw new Error(`PumpSwap ${accountName} RPC account has an unsupported layout length.`);
  }
  if (new PublicKey(account.data.subarray(0, 32)).toBase58() !== expectedMint) {
    throw new Error(`PumpSwap ${accountName} RPC account mint does not match policy.`);
  }
  if (account.data.readUInt8(108) !== 1) {
    throw new Error(`PumpSwap ${accountName} RPC account is not initialized.`);
  }
  const amount = account.data.readBigUInt64LE(64);
  if (amount === 0n) {
    throw new Error(`PumpSwap ${accountName} RPC account has zero liquidity.`);
  }
  return amount.toString();
}

export function decodePumpswapReserveSnapshot(
  trade: PumpswapTradeAccounts,
  requestedAddresses: readonly string[],
  returnedAccounts: unknown,
  slot: number,
  source: string,
  observedAt: string,
): ReserveSnapshot {
  if (!Array.isArray(returnedAccounts) || returnedAccounts.length !== requestedAddresses.length) {
    throw new Error("PumpSwap reserve account returns do not match the requested address count.");
  }
  const baseIndex = requestedAddresses.indexOf(trade.poolBaseTokenAccount);
  const quoteIndex = requestedAddresses.indexOf(trade.poolQuoteTokenAccount);
  if (baseIndex < 0 || quoteIndex < 0 || baseIndex === quoteIndex) {
    throw new Error("PumpSwap reserve request is missing distinct policy-verified vault addresses.");
  }
  const baseAccount = returnedAccounts[baseIndex];
  const quoteAccount = returnedAccounts[quoteIndex];
  if (baseAccount === null || quoteAccount === null) {
    throw new Error("PumpSwap reserve read omitted a policy-verified vault account.");
  }
  return reserveSnapshotSchema.parse({
    schemaVersion: 1,
    decoderVersion: PINNED_RESERVE_DECODER_VERSIONS.pumpswap,
    eventId: `rpc-point-read:${source}:${slot}:${trade.poolAddress}`,
    kind: "reserve-updated",
    venue: "pumpswap",
    source,
    observedAt,
    slot,
    writeVersion: 0,
    poolAddress: trade.poolAddress,
    baseMint: trade.baseMint,
    quoteMint: trade.quoteMint,
    baseReserveRaw: decodeRpcTokenAmount(baseAccount, trade.baseMint, "base vault"),
    quoteReserveRaw: decodeRpcTokenAmount(quoteAccount, trade.quoteMint, "quote vault"),
  });
}

export function decodePumpswapReserveSnapshots(
  trades: readonly PumpswapTradeAccounts[],
  requestedAddresses: readonly string[],
  returnedAccounts: unknown,
  slot: number,
  source: string,
  observedAt: string,
): ReserveSnapshot[] {
  const snapshotsByPool = new Map<string, ReserveSnapshot>();
  for (const trade of trades) {
    const snapshot = decodePumpswapReserveSnapshot(
      trade,
      requestedAddresses,
      returnedAccounts,
      slot,
      source,
      observedAt,
    );
    const previous = snapshotsByPool.get(snapshot.poolAddress);
    if (previous && (previous.baseMint !== snapshot.baseMint
      || previous.quoteMint !== snapshot.quoteMint
      || previous.baseReserveRaw !== snapshot.baseReserveRaw
      || previous.quoteReserveRaw !== snapshot.quoteReserveRaw)) {
      throw new Error("PumpSwap transaction contains conflicting reserve identities for one pool.");
    }
    snapshotsByPool.set(snapshot.poolAddress, snapshot);
  }
  return [...snapshotsByPool.values()];
}

function decodeSimulationTokenAmount(
  input: unknown,
  expectedMint: string,
  accountName: string,
): string {
  if (typeof input !== "object" || input === null
    || !("owner" in input) || input.owner !== SPL_TOKEN_PROGRAM_ID
    || !("executable" in input) || input.executable !== false
    || !("data" in input) || !Array.isArray(input.data)
    || input.data.length !== 2 || typeof input.data[0] !== "string"
    || input.data[1] !== "base64") {
    throw new Error(`PumpSwap simulation ${accountName} account is malformed or not classic SPL Token data.`);
  }
  const data = Buffer.from(input.data[0], "base64");
  if (data.toString("base64") !== input.data[0] || data.length !== 165) {
    throw new Error(`PumpSwap simulation ${accountName} account has invalid base64 or layout length.`);
  }
  if (new PublicKey(data.subarray(0, 32)).toBase58() !== expectedMint) {
    throw new Error(`PumpSwap simulation ${accountName} account mint does not match policy.`);
  }
  if (data.readUInt8(108) !== 1) {
    throw new Error(`PumpSwap simulation ${accountName} account is not initialized.`);
  }
  return data.readBigUInt64LE(64).toString();
}

export function decodePumpswapSimulationVaultBalances(
  trade: PumpswapTradeAccounts,
  requestedAddresses: readonly string[],
  returnedAccounts: unknown,
): PumpswapSimulationVaultBalances {
  if (!Array.isArray(returnedAccounts) || returnedAccounts.length !== requestedAddresses.length) {
    throw new Error("PumpSwap simulation account returns do not match the requested address count.");
  }
  const baseIndex = requestedAddresses.indexOf(trade.poolBaseTokenAccount);
  const quoteIndex = requestedAddresses.indexOf(trade.poolQuoteTokenAccount);
  if (baseIndex < 0 || quoteIndex < 0 || baseIndex === quoteIndex) {
    throw new Error("PumpSwap simulation request is missing distinct policy-verified vault addresses.");
  }
  const baseAccount = returnedAccounts[baseIndex];
  const quoteAccount = returnedAccounts[quoteIndex];
  if (baseAccount === null || quoteAccount === null) {
    throw new Error("PumpSwap simulation omitted a policy-verified vault account.");
  }
  return {
    poolAddress: trade.poolAddress,
    baseMint: trade.baseMint,
    quoteMint: trade.quoteMint,
    postBaseReserveRaw: decodeSimulationTokenAmount(baseAccount, trade.baseMint, "base vault"),
    postQuoteReserveRaw: decodeSimulationTokenAmount(quoteAccount, trade.quoteMint, "quote vault"),
  };
}

export function derivePumpswapSimulationObservation(
  snapshotInput: unknown,
  balancesInput: unknown,
  inputSide: "base" | "quote",
  simulationSlot: number,
): PumpswapSimulationObservation {
  const snapshot = reserveSnapshotSchema.parse(snapshotInput);
  if (snapshot.venue !== "pumpswap") {
    throw new Error(`PumpSwap simulation observation cannot use ${snapshot.venue} reserve semantics.`);
  }
  const balances = z.object({
    poolAddress: publicKeySchema,
    baseMint: publicKeySchema,
    quoteMint: publicKeySchema,
    postBaseReserveRaw: z.string().regex(/^\d+$/),
    postQuoteReserveRaw: z.string().regex(/^\d+$/),
  }).parse(balancesInput);
  if (balances.poolAddress !== snapshot.poolAddress
    || balances.baseMint !== snapshot.baseMint
    || balances.quoteMint !== snapshot.quoteMint) {
    throw new Error("PumpSwap simulation vault balances do not match the reserve snapshot identity.");
  }
  if (!Number.isSafeInteger(simulationSlot) || simulationSlot < 0) {
    throw new Error("PumpSwap simulation observation slot must be a non-negative safe integer.");
  }
  const preBaseReserve = BigInt(snapshot.baseReserveRaw);
  const preQuoteReserve = BigInt(snapshot.quoteReserveRaw);
  const postBaseReserve = BigInt(balances.postBaseReserveRaw);
  const postQuoteReserve = BigInt(balances.postQuoteReserveRaw);
  const effectiveInputAmount = inputSide === "base"
    ? postBaseReserve - preBaseReserve
    : postQuoteReserve - preQuoteReserve;
  const outputAmount = inputSide === "base"
    ? preQuoteReserve - postQuoteReserve
    : preBaseReserve - postBaseReserve;
  if (effectiveInputAmount <= 0n || outputAmount <= 0n) {
    throw new Error("PumpSwap simulation vault balances do not describe a positive exact-input swap.");
  }
  return {
    poolAddress: snapshot.poolAddress,
    baseMint: snapshot.baseMint,
    quoteMint: snapshot.quoteMint,
    inputSide,
    slot: simulationSlot,
    effectiveInputAmountRaw: effectiveInputAmount.toString(),
    outputAmountRaw: outputAmount.toString(),
    postBaseReserveRaw: balances.postBaseReserveRaw,
    postQuoteReserveRaw: balances.postQuoteReserveRaw,
  };
}

function ceilingRatio(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function rawDivergenceBps(expectedRaw: string, observedRaw: string): number {
  const expected = BigInt(expectedRaw);
  const observed = BigInt(observedRaw);
  if (expected === 0n) throw new Error("PumpSwap simulation comparison expected a nonzero value.");
  const difference = expected > observed ? expected - observed : observed - expected;
  return Number(ceilingRatio(difference * 10_000n, expected));
}

export function assertPumpswapSimulationAgreement(
  quote: PumpswapExactInputQuote,
  input: unknown,
  maxSlotSkew: number,
  maxDivergenceBps: number,
): PumpswapSimulationAgreement {
  if (!Number.isSafeInteger(maxSlotSkew) || maxSlotSkew < 0) {
    throw new Error("PumpSwap simulation slot skew must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(maxDivergenceBps)
    || maxDivergenceBps < 0
    || maxDivergenceBps > 10_000) {
    throw new Error("PumpSwap simulation divergence must be an integer between 0 and 10000 basis points.");
  }
  const observation = pumpswapSimulationObservationSchema.parse(input);
  if (observation.poolAddress !== quote.poolAddress
    || observation.baseMint !== quote.baseMint
    || observation.quoteMint !== quote.quoteMint
    || observation.inputSide !== quote.inputSide) {
    throw new Error("PumpSwap simulation pool, ordered mint pair, or input side does not match the quote.");
  }
  const slotSkew = observation.slot - quote.slot;
  if (slotSkew < 0) {
    throw new Error(`PumpSwap simulation slot ${observation.slot} regressed below quote slot ${quote.slot}.`);
  }
  if (slotSkew > maxSlotSkew) {
    throw new Error(`PumpSwap simulation slot skew ${slotSkew} exceeds ${maxSlotSkew}.`);
  }
  const divergenceBps = {
    effectiveInputAmount: rawDivergenceBps(
      quote.effectiveInputAmountRaw,
      observation.effectiveInputAmountRaw,
    ),
    outputAmount: rawDivergenceBps(quote.outputAmountRaw, observation.outputAmountRaw),
    postBaseReserve: rawDivergenceBps(
      quote.postBaseReserveRaw,
      observation.postBaseReserveRaw,
    ),
    postQuoteReserve: rawDivergenceBps(
      quote.postQuoteReserveRaw,
      observation.postQuoteReserveRaw,
    ),
  };
  for (const [field, divergence] of Object.entries(divergenceBps)) {
    if (divergence > maxDivergenceBps) {
      throw new Error(
        `PumpSwap simulation ${field} divergence ${divergence} bps exceeds ${maxDivergenceBps} bps.`,
      );
    }
  }
  return {
    quoteSlot: quote.slot,
    simulationSlot: observation.slot,
    slotSkew,
    maxDivergenceBps,
    divergenceBps,
  };
}

export function quotePumpswapExactInput(
  input: unknown,
  inputSide: "base" | "quote",
  inputAmountRaw: bigint,
  feeBps: number,
  maxPriceImpactBps: number,
): PumpswapExactInputQuote {
  const snapshot = reserveSnapshotSchema.parse(input);
  if (snapshot.venue !== "pumpswap") {
    throw new Error(`PumpSwap quote cannot use ${snapshot.venue} reserve semantics.`);
  }
  if (inputAmountRaw <= 0n) throw new Error("PumpSwap quote input must be positive.");
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) {
    throw new Error("PumpSwap fee must be an integer between 0 and 9999 basis points.");
  }
  if (!Number.isSafeInteger(maxPriceImpactBps)
    || maxPriceImpactBps < 0
    || maxPriceImpactBps > 10_000) {
    throw new Error("PumpSwap maximum price impact must be an integer between 0 and 10000 basis points.");
  }
  const inputReserve = BigInt(
    inputSide === "base" ? snapshot.baseReserveRaw : snapshot.quoteReserveRaw,
  );
  const outputReserve = BigInt(
    inputSide === "base" ? snapshot.quoteReserveRaw : snapshot.baseReserveRaw,
  );
  if (inputReserve === 0n || outputReserve === 0n) {
    throw new Error("PumpSwap quote requires nonzero reserves.");
  }
  const effectiveInputAmountRaw = inputAmountRaw * BigInt(10_000 - feeBps) / 10_000n;
  if (effectiveInputAmountRaw === 0n) {
    throw new Error("PumpSwap quote input rounds to zero after fees.");
  }
  const outputAmountRaw = outputReserve * effectiveInputAmountRaw
    / (inputReserve + effectiveInputAmountRaw);
  if (outputAmountRaw === 0n) {
    throw new Error("PumpSwap quote output rounds to zero.");
  }
  const spotOutputNumerator = effectiveInputAmountRaw * outputReserve;
  const executionOutputNumerator = outputAmountRaw * inputReserve;
  const impactNumerator = spotOutputNumerator - executionOutputNumerator;
  const priceImpactBps = ceilingRatio(impactNumerator * 10_000n, spotOutputNumerator);
  if (priceImpactBps > 10_000n) {
    throw new Error("PumpSwap quote produced invalid price impact.");
  }
  if (priceImpactBps > BigInt(maxPriceImpactBps)) {
    throw new Error(
      `PumpSwap price impact ${priceImpactBps} bps exceeds maximum ${maxPriceImpactBps} bps.`,
    );
  }
  const postInputReserve = inputReserve + effectiveInputAmountRaw;
  const postOutputReserve = outputReserve - outputAmountRaw;
  const postBaseReserve = inputSide === "base" ? postInputReserve : postOutputReserve;
  const postQuoteReserve = inputSide === "base" ? postOutputReserve : postInputReserve;
  const invariantBefore = inputReserve * outputReserve;
  const invariantAfter = postInputReserve * postOutputReserve;
  if (invariantAfter < invariantBefore) {
    throw new Error("PumpSwap quote reduced the constant-product invariant.");
  }
  return {
    modelVersion: "pumpswap-constant-product-v1",
    reserveEventId: snapshot.eventId,
    decoderVersion: snapshot.decoderVersion,
    poolAddress: snapshot.poolAddress,
    source: snapshot.source,
    observedAt: snapshot.observedAt,
    slot: snapshot.slot,
    writeVersion: snapshot.writeVersion,
    baseMint: snapshot.baseMint,
    quoteMint: snapshot.quoteMint,
    inputSide,
    inputAmountRaw: inputAmountRaw.toString(),
    feeBps,
    maxPriceImpactBps,
    feeAmountRaw: (inputAmountRaw - effectiveInputAmountRaw).toString(),
    effectiveInputAmountRaw: effectiveInputAmountRaw.toString(),
    outputAmountRaw: outputAmountRaw.toString(),
    priceImpactBps: Number(priceImpactBps),
    postBaseReserveRaw: postBaseReserve.toString(),
    postQuoteReserveRaw: postQuoteReserve.toString(),
    invariantBeforeRaw: invariantBefore.toString(),
    invariantAfterRaw: invariantAfter.toString(),
  };
}

export interface ReserveSnapshotRequirements {
  now: string;
  maxAgeMs: number;
  maxSlotSkew: number;
}

export interface PumpswapCandidateQuoteRequirements {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  quoteSource: string;
  inputSide: "base" | "quote";
  inputAmountRaw: bigint;
  feeBps: number;
  maxPriceImpactBps: number;
  snapshots: ReserveSnapshotRequirements;
  maxReserveDivergenceBps?: number;
}

export interface PumpswapCandidateSimulationRequirements
  extends PumpswapCandidateQuoteRequirements {
  simulationMaxSlotSkew: number;
  simulationMaxDivergenceBps: number;
}

export interface PumpswapCandidateSimulationAdmission {
  quote: PumpswapExactInputQuote;
  simulation: PumpswapSimulationAgreement;
}

export interface PumpswapCandidateVaultSimulationAdmission
  extends PumpswapCandidateSimulationAdmission {
  observation: PumpswapSimulationObservation;
}

export function quoteAdmissiblePumpswapCandidate(
  input: readonly unknown[],
  requirements: PumpswapCandidateQuoteRequirements,
): PumpswapExactInputQuote {
  const poolAddress = publicKeySchema.parse(requirements.poolAddress);
  const baseMint = publicKeySchema.parse(requirements.baseMint);
  const quoteMint = publicKeySchema.parse(requirements.quoteMint);
  if (requirements.quoteSource.length === 0) {
    throw new Error("PumpSwap candidate quote source is required.");
  }
  if (input.length > 1 && requirements.maxReserveDivergenceBps === undefined) {
    throw new Error("PumpSwap candidate requires a reserve divergence limit for multiple sources.");
  }
  const snapshots = requirements.maxReserveDivergenceBps === undefined
    ? assertReserveSnapshotsUsable(input, requirements.snapshots)
    : assertReserveSourcesConverged(
        input,
        requirements.snapshots,
        requirements.maxReserveDivergenceBps,
      );
  const mismatched = snapshots.find((snapshot) => snapshot.venue !== "pumpswap"
    || snapshot.poolAddress !== poolAddress
    || snapshot.baseMint !== baseMint
    || snapshot.quoteMint !== quoteMint);
  if (mismatched) {
    throw new Error("PumpSwap candidate reserve pool or ordered mint pair does not match.");
  }
  const selected = snapshots.find((snapshot) => snapshot.source === requirements.quoteSource);
  if (!selected) {
    throw new Error(`PumpSwap candidate quote source ${requirements.quoteSource} is unavailable.`);
  }
  return quotePumpswapExactInput(
    selected,
    requirements.inputSide,
    requirements.inputAmountRaw,
    requirements.feeBps,
    requirements.maxPriceImpactBps,
  );
}

export function assertPumpswapCandidateSimulationAdmissible(
  snapshots: readonly unknown[],
  simulationObservation: unknown,
  requirements: PumpswapCandidateSimulationRequirements,
): PumpswapCandidateSimulationAdmission {
  const quote = quoteAdmissiblePumpswapCandidate(snapshots, requirements);
  const simulation = assertPumpswapSimulationAgreement(
    quote,
    simulationObservation,
    requirements.simulationMaxSlotSkew,
    requirements.simulationMaxDivergenceBps,
  );
  return { quote, simulation };
}

export function assertPumpswapCandidateVaultSimulationAdmissible(
  snapshots: readonly unknown[],
  balances: unknown,
  simulationSlot: number,
  requirements: PumpswapCandidateSimulationRequirements,
): PumpswapCandidateVaultSimulationAdmission {
  const quote = quoteAdmissiblePumpswapCandidate(snapshots, requirements);
  const selectedSnapshots = snapshots
    .map((snapshot) => reserveSnapshotSchema.parse(snapshot))
    .filter((snapshot) => snapshot.eventId === quote.reserveEventId);
  if (selectedSnapshots.length !== 1) {
    throw new Error("PumpSwap quote does not bind to exactly one reserve snapshot event.");
  }
  const observation = derivePumpswapSimulationObservation(
    selectedSnapshots[0],
    balances,
    requirements.inputSide,
    simulationSlot,
  );
  const simulation = assertPumpswapSimulationAgreement(
    quote,
    observation,
    requirements.simulationMaxSlotSkew,
    requirements.simulationMaxDivergenceBps,
  );
  return { quote, observation, simulation };
}

export function assertReserveSnapshotAdvances(
  previousInput: unknown,
  nextInput: unknown,
): ReserveSnapshot {
  const previous = reserveSnapshotSchema.parse(previousInput);
  const next = reserveSnapshotSchema.parse(nextInput);
  if (
    next.venue !== previous.venue
    || next.poolAddress !== previous.poolAddress
    || next.baseMint !== previous.baseMint
    || next.quoteMint !== previous.quoteMint
    || next.source !== previous.source
    || next.decoderVersion !== previous.decoderVersion
  ) {
    throw new Error("Reserve snapshot update identity does not match the previous snapshot.");
  }
  if (Date.parse(next.observedAt) < Date.parse(previous.observedAt)) {
    throw new Error("Reserve snapshot observation time regressed.");
  }
  if (next.slot < previous.slot) {
    throw new Error(`Reserve snapshot slot regressed from ${previous.slot} to ${next.slot}.`);
  }
  if (next.slot === previous.slot && next.writeVersion <= previous.writeVersion) {
    throw new Error(
      `Reserve snapshot write version did not advance beyond ${previous.writeVersion}.`,
    );
  }
  return next;
}

export function assertReserveSnapshotsUsable(
  input: readonly unknown[],
  requirements: ReserveSnapshotRequirements,
): ReserveSnapshot[] {
  if (!Number.isFinite(requirements.maxAgeMs) || requirements.maxAgeMs < 0) {
    throw new Error("Reserve snapshot maximum age must be non-negative.");
  }
  if (!Number.isSafeInteger(requirements.maxSlotSkew) || requirements.maxSlotSkew < 0) {
    throw new Error("Reserve snapshot maximum slot skew must be a non-negative safe integer.");
  }
  const nowMs = Date.parse(requirements.now);
  if (!Number.isFinite(nowMs)) throw new Error("Reserve snapshot comparison time is invalid.");
  if (input.length === 0) throw new Error("At least one reserve snapshot is required.");

  const snapshots = input.map((snapshot) => reserveSnapshotSchema.parse(snapshot));
  const [first] = snapshots;
  if (!first) throw new Error("At least one reserve snapshot is required.");
  const identities = new Set<string>();
  let minimumSlot = first.slot;
  let maximumSlot = first.slot;

  for (const snapshot of snapshots) {
    const observedAtMs = Date.parse(snapshot.observedAt);
    const ageMs = nowMs - observedAtMs;
    if (ageMs < 0) throw new Error(`Reserve snapshot ${snapshot.eventId} is from the future.`);
    if (ageMs > requirements.maxAgeMs) {
      throw new Error(`Reserve snapshot ${snapshot.eventId} is stale by ${ageMs}ms.`);
    }
    if (snapshot.baseMint === snapshot.quoteMint) {
      throw new Error(`Reserve snapshot ${snapshot.eventId} uses the same mint on both sides.`);
    }
    if (BigInt(snapshot.baseReserveRaw) === 0n || BigInt(snapshot.quoteReserveRaw) === 0n) {
      throw new Error(`Reserve snapshot ${snapshot.eventId} has zero liquidity.`);
    }
    if (snapshot.baseMint !== first.baseMint || snapshot.quoteMint !== first.quoteMint) {
      throw new Error("Reserve snapshots do not describe the same ordered mint pair.");
    }
    const identity = `${snapshot.venue}:${snapshot.poolAddress}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate reserve snapshot for ${identity}.`);
    }
    identities.add(identity);
    minimumSlot = Math.min(minimumSlot, snapshot.slot);
    maximumSlot = Math.max(maximumSlot, snapshot.slot);
  }

  if (maximumSlot - minimumSlot > requirements.maxSlotSkew) {
    throw new Error(
      `Reserve snapshot slot skew ${maximumSlot - minimumSlot} exceeds ${requirements.maxSlotSkew}.`,
    );
  }
  return snapshots;
}

function divergenceBps(referenceRaw: string, candidateRaw: string): bigint {
  const reference = BigInt(referenceRaw);
  const candidate = BigInt(candidateRaw);
  const difference = reference > candidate ? reference - candidate : candidate - reference;
  const denominator = reference < candidate ? reference : candidate;
  return (difference * 10_000n + denominator - 1n) / denominator;
}

export function assertReserveSourcesConverged(
  input: readonly unknown[],
  requirements: ReserveSnapshotRequirements,
  maxDivergenceBps: number,
): ReserveSnapshot[] {
  if (!Number.isSafeInteger(maxDivergenceBps) || maxDivergenceBps < 0) {
    throw new Error("Reserve divergence limit must be a non-negative safe integer.");
  }
  if (input.length < 2) throw new Error("At least two reserve sources are required.");
  const snapshots = input.map((item) => assertReserveSnapshotsUsable([item], requirements)[0]!);
  const [reference] = snapshots;
  if (!reference) throw new Error("At least two reserve sources are required.");
  const sources = new Set<string>();
  let minimumSlot = reference.slot;
  let maximumSlot = reference.slot;

  for (const snapshot of snapshots) {
    if (
      snapshot.venue !== reference.venue
      || snapshot.poolAddress !== reference.poolAddress
      || snapshot.baseMint !== reference.baseMint
      || snapshot.quoteMint !== reference.quoteMint
      || snapshot.decoderVersion !== reference.decoderVersion
    ) {
      throw new Error("Reserve sources do not describe the same decoded pool state.");
    }
    if (sources.has(snapshot.source)) {
      throw new Error(`Duplicate reserve source ${snapshot.source}.`);
    }
    sources.add(snapshot.source);
    minimumSlot = Math.min(minimumSlot, snapshot.slot);
    maximumSlot = Math.max(maximumSlot, snapshot.slot);

    const baseDivergence = divergenceBps(reference.baseReserveRaw, snapshot.baseReserveRaw);
    const quoteDivergence = divergenceBps(reference.quoteReserveRaw, snapshot.quoteReserveRaw);
    if (baseDivergence > BigInt(maxDivergenceBps)
      || quoteDivergence > BigInt(maxDivergenceBps)) {
      throw new Error(
        `Reserve source ${snapshot.source} diverges by ${baseDivergence} base bps and ${quoteDivergence} quote bps.`,
      );
    }
  }
  if (maximumSlot - minimumSlot > requirements.maxSlotSkew) {
    throw new Error(
      `Reserve source slot skew ${maximumSlot - minimumSlot} exceeds ${requirements.maxSlotSkew}.`,
    );
  }
  return snapshots.sort((left, right) => left.source.localeCompare(right.source));
}

function snapshotStoreKey(
  snapshot: Pick<ReserveSnapshot, "source" | "venue" | "poolAddress">,
): string {
  return `${snapshot.source}:${snapshot.venue}:${snapshot.poolAddress}`;
}

export class ReserveSnapshotStore {
  readonly #snapshots = new Map<string, ReserveSnapshot>();

  constructor(private readonly maxEntries = 10_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Reserve snapshot store capacity must be a positive safe integer.");
    }
  }

  get size(): number {
    return this.#snapshots.size;
  }

  ingest(input: unknown): ReserveSnapshot {
    const snapshot = reserveSnapshotSchema.parse(input);
    const key = snapshotStoreKey(snapshot);
    const previous = this.#snapshots.get(key);
    if (previous) assertReserveSnapshotAdvances(previous, snapshot);

    this.#snapshots.delete(key);
    this.#snapshots.set(key, snapshot);
    if (this.#snapshots.size > this.maxEntries) {
      const oldestKey = this.#snapshots.keys().next().value;
      if (oldestKey !== undefined) this.#snapshots.delete(oldestKey);
    }
    return snapshot;
  }

  getUsablePair(
    baseMint: string,
    quoteMint: string,
    requirements: ReserveSnapshotRequirements,
    source?: string,
  ): ReserveSnapshot[] {
    const matching = [...this.#snapshots.values()]
      .filter((snapshot) => snapshot.baseMint === baseMint
        && snapshot.quoteMint === quoteMint
        && (source === undefined || snapshot.source === source))
      .sort((left, right) => snapshotStoreKey(left).localeCompare(snapshotStoreKey(right)));
    return assertReserveSnapshotsUsable(matching, requirements);
  }

  getConvergedPool(
    venue: ReserveSnapshot["venue"],
    poolAddress: string,
    requirements: ReserveSnapshotRequirements,
    maxDivergenceBps: number,
  ): ReserveSnapshot[] {
    const matching = [...this.#snapshots.values()]
      .filter((snapshot) => snapshot.venue === venue && snapshot.poolAddress === poolAddress);
    return assertReserveSourcesConverged(matching, requirements, maxDivergenceBps);
  }
}