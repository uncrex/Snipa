import { projectionEventSchema, type ProjectionEvent } from "./projection-events.js";

const stageOrder = [
  "detected",
  "token-safety",
  "wallet-intelligence",
  "market-analysis",
  "decision",
  "position",
  "completed",
] as const;

type ScannerStatus = "scanning" | "qualified" | "rejected" | "monitoring"
  | "skipped" | "entered" | "exited";

export interface ScannerTimelineEntry {
  projectionId: string;
  type: "token-detected" | "token-status-changed";
  occurredAt: string;
  stage: typeof stageOrder[number];
  status: ScannerStatus;
  reasons: string[];
  observationToDecisionMs?: number;
}

const allowedStatusTransitions: Record<ScannerStatus, ReadonlySet<ScannerStatus>> = {
  scanning: new Set<ScannerStatus>(["scanning", "qualified", "rejected", "monitoring", "skipped", "entered"]),
  qualified: new Set<ScannerStatus>(["qualified", "rejected", "monitoring", "skipped", "entered"]),
  monitoring: new Set<ScannerStatus>(["monitoring", "qualified", "rejected", "skipped", "entered"]),
  entered: new Set<ScannerStatus>(["entered", "exited"]),
  rejected: new Set<ScannerStatus>(),
  skipped: new Set<ScannerStatus>(),
  exited: new Set<ScannerStatus>(),
};

export interface ScannerToken {
  tokenEventId: string;
  mint: string;
  name: string;
  symbol: string;
  venue: string;
  detectedAt: string;
  updatedAt: string;
  stage: typeof stageOrder[number];
  status: ScannerStatus;
  reasons: string[];
  timeline: ScannerTimelineEntry[];
}

export interface ScannerReplayResult {
  model: ScannerReadModel;
  validLines: number;
  invalidLines: number;
  duplicateEvents: number;
  rejectedTransitions: number;
}

export interface ScannerStreamHealth {
  source: "pumpportal";
  status: "connected" | "disconnected" | "compromised";
  updatedAt: string;
  reason: string | null;
}

export class ScannerReadModel {
  readonly #tokens = new Map<string, ScannerToken>();
  readonly #streams = new Map<ScannerStreamHealth["source"], ScannerStreamHealth>();
  readonly #seenProjectionIds = new Set<string>();

  apply(input: unknown): "applied" | "duplicate" {
    const event = projectionEventSchema.parse(input);
    if (this.#seenProjectionIds.has(event.projectionId)) return "duplicate";

    if (event.type === "token-detected") {
      const existing = this.#tokens.get(event.token.eventId);
      if (existing) throw new Error(`Conflicting detection for ${event.token.eventId}.`);
      this.#tokens.set(event.token.eventId, {
        tokenEventId: event.token.eventId,
        mint: event.token.mint,
        name: event.token.name,
        symbol: event.token.symbol,
        venue: event.token.venue,
        detectedAt: event.occurredAt,
        updatedAt: event.occurredAt,
        stage: event.stage,
        status: event.status,
        reasons: [],
        timeline: [{
          projectionId: event.projectionId,
          type: event.type,
          occurredAt: event.occurredAt,
          stage: event.stage,
          status: event.status,
          reasons: [],
        }],
      });
    } else if (event.type === "token-status-changed") {
      const token = this.#tokens.get(event.tokenEventId);
      if (!token) throw new Error(`Status update references unknown token ${event.tokenEventId}.`);
      if (token.mint !== event.mint) {
        throw new Error(`Status update mint does not match ${event.tokenEventId}.`);
      }
      if (Date.parse(event.occurredAt) < Date.parse(token.updatedAt)) {
        throw new Error(`Status update time regressed for ${event.tokenEventId}.`);
      }
      if (stageOrder.indexOf(event.stage) < stageOrder.indexOf(token.stage)) {
        throw new Error(`Status update stage regressed for ${event.tokenEventId}.`);
      }
      if (!allowedStatusTransitions[token.status].has(event.status)) {
        throw new Error(
          `Invalid scanner status transition from ${token.status} to ${event.status}.`,
        );
      }
      this.#tokens.set(event.tokenEventId, {
        ...token,
        updatedAt: event.occurredAt,
        stage: event.stage,
        status: event.status,
        reasons: [...event.reasons],
        timeline: [...token.timeline, {
          projectionId: event.projectionId,
          type: event.type,
          occurredAt: event.occurredAt,
          stage: event.stage,
          status: event.status,
          reasons: [...event.reasons],
          observationToDecisionMs: event.observationToDecisionMs,
        }],
      });
    } else {
      const existing = this.#streams.get(event.source);
      if (existing && Date.parse(event.occurredAt) < Date.parse(existing.updatedAt)) {
        throw new Error(`Stream health time regressed for ${event.source}.`);
      }
      this.#streams.set(event.source, {
        source: event.source,
        status: event.status,
        updatedAt: event.occurredAt,
        reason: event.reason,
      });
    }

    this.#seenProjectionIds.add(event.projectionId);
    return "applied";
  }

  tokens(): ScannerToken[] {
    return [...this.#tokens.values()]
      .map((token) => ({
        ...token,
        reasons: [...token.reasons],
        timeline: token.timeline.map((entry) => ({
          ...entry,
          reasons: [...entry.reasons],
        })),
      }))
      .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt)
        || left.tokenEventId.localeCompare(right.tokenEventId));
  }

    streamHealth(): ScannerStreamHealth[] {
      return [...this.#streams.values()]
        .map((stream) => ({ ...stream }))
        .sort((left, right) => left.source.localeCompare(right.source));
    }
}

export function replayScannerEvents(contents: string): ScannerReplayResult {
  const result: ScannerReplayResult = {
    model: new ScannerReadModel(),
    validLines: 0,
    invalidLines: 0,
    duplicateEvents: 0,
    rejectedTransitions: 0,
  };
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: ProjectionEvent;
    try {
      event = projectionEventSchema.parse(JSON.parse(line) as unknown);
    } catch {
      result.invalidLines += 1;
      continue;
    }
    try {
      const outcome = result.model.apply(event);
      if (outcome === "duplicate") result.duplicateEvents += 1;
      else result.validLines += 1;
    } catch {
      result.rejectedTransitions += 1;
    }
  }
  return result;
}