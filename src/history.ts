import { readFile } from "node:fs/promises";
import { tradeJournalEntrySchema, type TradeJournalEntry } from "./journal.js";

export interface TradeHistorySummary {
  records: number;
  buys: number;
  sells: number;
  buySpendSol: number;
  live: number;
  paper: number;
  invalidLines: number;
  missing: boolean;
  submissionToConfirmation: {
    sampleCount: number;
    invalidSamples: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
    alertThresholdMs: number | null;
    aboveThresholdSamples: number;
    p95WithinThreshold: boolean | null;
  };
}

const emptySummary = (alertThresholdMs?: number): TradeHistorySummary => ({
  records: 0,
  buys: 0,
  sells: 0,
  buySpendSol: 0,
  live: 0,
  paper: 0,
  invalidLines: 0,
  missing: false,
  submissionToConfirmation: {
    sampleCount: 0,
    invalidSamples: 0,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
    alertThresholdMs: alertThresholdMs ?? null,
    aboveThresholdSamples: 0,
    p95WithinThreshold: null,
  },
});

function percentile(sortedValues: readonly number[], percentileValue: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.max(0, Math.ceil(percentileValue * sortedValues.length) - 1);
  return sortedValues[index] ?? null;
}

export function summarizeTradeHistory(
  contents: string,
  alertThresholdMs?: number,
): TradeHistorySummary {
  if (alertThresholdMs !== undefined
    && (!Number.isSafeInteger(alertThresholdMs) || alertThresholdMs <= 0)) {
    throw new Error("Submission confirmation alert threshold must be a positive safe integer.");
  }
  const summary = emptySummary(alertThresholdMs);
  const confirmationSamples: number[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let json: unknown;
    try {
      json = JSON.parse(line) as unknown;
    } catch {
      summary.invalidLines += 1;
      continue;
    }

    const parsed = tradeJournalEntrySchema.safeParse(json);
    if (!parsed.success) {
      summary.invalidLines += 1;
      continue;
    }

    const entry = parsed.data;
    if (entry.schemaVersion === 2
      && !["paper", "confirmed", "rejected", "failed"].includes(entry.status ?? "")) {
      continue;
    }
    summary.records += 1;
    summary.buys += entry.action === "buy" ? 1 : 0;
    summary.sells += entry.action === "sell" ? 1 : 0;
    summary.live += entry.mode === "LIVE" ? 1 : 0;
    summary.paper += entry.mode === "PAPER" ? 1 : 0;
    if (entry.action === "buy" && entry.denominatedInSol && typeof entry.amount === "number") {
      summary.buySpendSol += entry.amount;
    }
    if (entry.schemaVersion === 2
      && entry.mode === "LIVE"
      && entry.status === "confirmed"
      && entry.submittedAt
      && entry.finalizedAt) {
      const durationMs = Date.parse(entry.finalizedAt) - Date.parse(entry.submittedAt);
      if (durationMs < 0) summary.submissionToConfirmation.invalidSamples += 1;
      else confirmationSamples.push(durationMs);
    }
  }
  confirmationSamples.sort((left, right) => left - right);
  summary.submissionToConfirmation.sampleCount = confirmationSamples.length;
  summary.submissionToConfirmation.p50Ms = percentile(confirmationSamples, 0.5);
  summary.submissionToConfirmation.p95Ms = percentile(confirmationSamples, 0.95);
  summary.submissionToConfirmation.maxMs = confirmationSamples.at(-1) ?? null;
  if (alertThresholdMs !== undefined) {
    summary.submissionToConfirmation.aboveThresholdSamples = confirmationSamples
      .filter((durationMs) => durationMs > alertThresholdMs)
      .length;
    const p95Ms = summary.submissionToConfirmation.p95Ms;
    summary.submissionToConfirmation.p95WithinThreshold = p95Ms === null
      ? null
      : p95Ms <= alertThresholdMs;
  }
  return summary;
}

export async function readTradeHistory(
  path: string,
  alertThresholdMs?: number,
): Promise<TradeHistorySummary> {
  try {
    return summarizeTradeHistory(await readFile(path, "utf8"), alertThresholdMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...emptySummary(alertThresholdMs), missing: true };
    }
    throw error;
  }
}

export interface TradeJournalState {
  unresolvedSubmissions: TradeJournalEntry[];
  invalidLines: number;
  missing: boolean;
}

export function analyzeTradeJournalState(contents: string): TradeJournalState {
  const latestByDecision = new Map<string, TradeJournalEntry>();
  let invalidLines = 0;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line) as unknown;
    } catch {
      invalidLines += 1;
      continue;
    }
    const parsed = tradeJournalEntrySchema.safeParse(json);
    if (!parsed.success) {
      invalidLines += 1;
      continue;
    }
    const entry = parsed.data;
    if (entry.schemaVersion === 2 && entry.decisionId) {
      latestByDecision.set(entry.decisionId, entry);
    }
  }
  return {
    unresolvedSubmissions: [...latestByDecision.values()]
      .filter((entry) => entry.status === "submitted" && entry.signature !== null)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    invalidLines,
    missing: false,
  };
}

export async function readTradeJournalState(path: string): Promise<TradeJournalState> {
  try {
    return analyzeTradeJournalState(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { unresolvedSubmissions: [], invalidLines: 0, missing: true };
    }
    throw error;
  }
}