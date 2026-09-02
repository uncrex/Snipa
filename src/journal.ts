import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { pumpswapFeeConfigSnapshotSchema } from "./pumpswap-fees.js";
import { reserveSnapshotSchema } from "./reserve-snapshots.js";

const rawAmountSchema = z.string().regex(/^\d+$/);
const pumpswapTradeIdentitySchema = z.object({
  poolAddress: z.string().min(1),
  baseMint: z.string().min(1),
  quoteMint: z.string().min(1),
  poolBaseTokenAccount: z.string().min(1),
  poolQuoteTokenAccount: z.string().min(1),
  globalConfigAddress: z.string().min(1),
  feeConfigAddress: z.string().min(1),
  feeProgramAddress: z.string().min(1),
});
const pumpswapTradeSchema = z.discriminatedUnion("instructionName", [
  pumpswapTradeIdentitySchema.extend({
    instructionName: z.literal("buy"),
    inputSemantics: z.literal("maximum-quote-input"),
    exactBaseOutputRaw: rawAmountSchema,
    maxQuoteInputRaw: rawAmountSchema,
  }),
  pumpswapTradeIdentitySchema.extend({
    instructionName: z.literal("buy_exact_quote_in"),
    inputSemantics: z.literal("exact-quote-input"),
    exactQuoteInputRaw: rawAmountSchema,
    minBaseOutputRaw: rawAmountSchema,
  }),
  pumpswapTradeIdentitySchema.extend({
    instructionName: z.literal("sell"),
    inputSemantics: z.literal("exact-base-input"),
    exactBaseInputRaw: rawAmountSchema,
    minQuoteOutputRaw: rawAmountSchema,
  }),
]);

export const tradeJournalEntrySchema = z.object({
  schemaVersion: z.literal(2).optional(),
  decisionId: z.string().uuid().optional(),
  timestamp: z.string().datetime(),
  candidateAt: z.string().datetime().optional(),
  decisionAt: z.string().datetime().nullable().optional(),
  simulationAt: z.string().datetime().nullable().optional(),
  submittedAt: z.string().datetime().nullable().optional(),
  finalizedAt: z.string().datetime().nullable().optional(),
  action: z.enum(["buy", "sell"]),
  mint: z.string().min(1),
  amount: z.union([z.number().positive(), z.string().min(1)]),
  denominatedInSol: z.boolean(),
  mode: z.enum(["LIVE", "PAPER"]),
  wallet: z.string().min(1),
  signature: z.string().min(1).nullable(),
  status: z.enum([
    "candidate",
    "asset-validated",
    "policy-approved",
    "simulation-completed",
    "submitted",
    "paper",
    "confirmed",
    "rejected",
    "failed",
  ]).optional(),
  rejectionReason: z.string().min(1).nullable().optional(),
  assetValidation: z.object({
    tokenProgram: z.string().min(1),
    decimals: z.number().int().nonnegative().max(255),
    supplyRaw: z.string().regex(/^\d+$/),
    mintAuthority: z.null(),
    freezeAuthority: z.null(),
  }).optional(),
  route: z.string().min(1).optional(),
  expectedOutput: z.number().nonnegative().nullable().optional(),
  reserveSnapshots: z.array(reserveSnapshotSchema).optional(),
  pumpswapFeeConfigSnapshot: pumpswapFeeConfigSnapshotSchema.optional(),
  pumpswapTrades: z.array(pumpswapTradeSchema).optional(),
  fees: z.object({
    priorityFeeSol: z.number().nonnegative(),
    maxPriorityFeeLamports: z.string().regex(/^\d+$/),
    computeUnitLimit: z.number().int().positive().max(1_400_000).optional(),
    computeUnitPriceMicroLamports: z.string().regex(/^\d+$/).optional(),
    transactionPriorityFeeLamports: z.string().regex(/^\d+$/).optional(),
  }).optional(),
  simulation: z.object({
    error: z.unknown().nullable(),
    unitsConsumed: z.number().int().nonnegative().nullable(),
    computeUnitUtilizationBps: z.number().int().nonnegative().max(10_000).nullable().optional(),
    pumpswapVaultBalances: z.array(z.object({
      poolAddress: z.string().min(1),
      baseMint: z.string().min(1),
      quoteMint: z.string().min(1),
      postBaseReserveRaw: z.string().regex(/^\d+$/),
      postQuoteReserveRaw: z.string().regex(/^\d+$/),
    })).nullable().optional(),
  }).nullable().optional(),
  submission: z.object({
    signature: z.string().min(1),
    blockhash: z.string().min(1).optional(),
    lastValidBlockHeight: z.number().int().nonnegative().optional(),
  }).nullable().optional(),
  decisionInputs: z.object({
    slippagePercent: z.number().nonnegative(),
    buyAmountCapSol: z.number().positive(),
    minSolReserve: z.number().nonnegative(),
    allowedProgramIds: z.array(z.string().min(1)),
    maxSellAmountRaw: z.string().regex(/^\d+$/).nullable().optional(),
    maxTradeIntentAgeMs: z.number().int().positive().optional(),
    minComputeHeadroomBps: z.number().int().min(1).max(9_999).optional(),
  }).optional(),
});

export type TradeJournalEntry = z.infer<typeof tradeJournalEntrySchema>;

type JournalWriter = (path: string, entry: TradeJournalEntry) => Promise<void>;

export function serializeTradeEntry(entry: TradeJournalEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

export async function appendTradeJournal(
  path: string,
  entry: TradeJournalEntry,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, serializeTradeEntry(entry), { encoding: "utf8" });
}

export async function journalTradeSafely(
  path: string,
  entry: TradeJournalEntry,
  writer: JournalWriter = appendTradeJournal,
): Promise<boolean> {
  try {
    await writer(path, entry);
    return true;
  } catch (error) {
    console.error(`Trade journal write failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}