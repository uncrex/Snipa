import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import {
  normalizedLaunchEventSchema,
  type NormalizedLaunchEvent,
} from "./market-events.js";

const scannerStageSchema = z.enum([
  "detected",
  "token-safety",
  "wallet-intelligence",
  "market-analysis",
  "decision",
  "position",
  "completed",
]);

const scannerStatusSchema = z.enum([
  "scanning",
  "qualified",
  "rejected",
  "monitoring",
  "skipped",
  "entered",
  "exited",
]);

const publicKeySchema = z.string().refine((value) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid Solana public key");

const tokenDetectedProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  projectionId: z.string().min(1),
  type: z.literal("token-detected"),
  occurredAt: z.string().datetime(),
  stage: z.literal("detected"),
  status: z.literal("scanning"),
  token: normalizedLaunchEventSchema,
});

const tokenStatusChangedProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  projectionId: z.string().min(1),
  type: z.literal("token-status-changed"),
  occurredAt: z.string().datetime(),
  tokenEventId: z.string().min(1),
  mint: publicKeySchema,
  stage: scannerStageSchema,
  status: scannerStatusSchema,
  reasons: z.array(z.string().min(1)),
  observationToDecisionMs: z.number().int().nonnegative().optional(),
}).superRefine((event, context) => {
  if (["rejected", "skipped"].includes(event.status) && event.reasons.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["reasons"],
      message: `${event.status} status requires at least one exact reason`,
    });
  }
  if (event.observationToDecisionMs !== undefined && event.stage !== "decision") {
    context.addIssue({
      code: "custom",
      path: ["observationToDecisionMs"],
      message: "observation-to-decision latency is valid only for decision-stage events",
    });
  }
});

const streamHealthChangedProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  projectionId: z.string().min(1),
  type: z.literal("stream-health-changed"),
  occurredAt: z.string().datetime(),
  source: z.literal("pumpportal"),
  status: z.enum(["connected", "disconnected", "compromised"]),
  reason: z.string().min(1).nullable(),
}).superRefine((event, context) => {
  if (event.status === "connected" && event.reason !== null) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "connected stream health cannot include a failure reason",
    });
  }
  if (event.status !== "connected" && event.reason === null) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: `${event.status} stream health requires an exact reason`,
    });
  }
});

export const projectionEventSchema = z.union([
  tokenDetectedProjectionSchema,
  tokenStatusChangedProjectionSchema,
  streamHealthChangedProjectionSchema,
]);

export type ProjectionEvent = z.infer<typeof projectionEventSchema>;
export type ProjectionEventSink = (event: ProjectionEvent) => Promise<void>;

export interface ProjectionPublisherHealth {
  queueDepth: number;
  inFlight: boolean;
  accepted: number;
  published: number;
  dropped: number;
  failures: number;
  oldestEventAgeMs: number;
  lastPublishedAt: string | null;
}

interface QueuedProjection {
  event: ProjectionEvent;
  enqueuedAtMs: number;
}

export function tokenDetectedProjection(event: NormalizedLaunchEvent): ProjectionEvent {
  return projectionEventSchema.parse({
    schemaVersion: 1,
    projectionId: `dashboard:token-detected:${event.eventId}`,
    type: "token-detected",
    occurredAt: event.observedAt,
    stage: "detected",
    status: "scanning",
    token: event,
  });
}

export function serializeProjectionEvent(event: ProjectionEvent): string {
  return `${JSON.stringify(projectionEventSchema.parse(event))}\n`;
}

export async function appendProjectionEvent(
  path: string,
  event: ProjectionEvent,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, serializeProjectionEvent(event), { encoding: "utf8" });
}

export class AsyncProjectionPublisher {
  readonly #queue: QueuedProjection[] = [];
  readonly #idleWaiters = new Set<() => void>();
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  #processing = false;
  #inFlightEnqueuedAtMs: number | null = null;
  #accepted = 0;
  #published = 0;
  #dropped = 0;
  #failures = 0;
  #lastPublishedAt: string | null = null;

  constructor(
    private readonly sink: ProjectionEventSink,
    private readonly maxQueue = 1_000,
    options: { now?: () => number; onError?: (error: unknown) => void } = {},
  ) {
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) {
      throw new Error("Projection queue capacity must be a positive safe integer.");
    }
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => undefined);
  }

  publish(input: unknown): boolean {
    const event = projectionEventSchema.parse(input);
    if (this.#queue.length >= this.maxQueue) {
      this.#dropped += 1;
      return false;
    }
    this.#queue.push({ event, enqueuedAtMs: this.#now() });
    this.#accepted += 1;
    void this.#drain();
    return true;
  }

  health(): ProjectionPublisherHealth {
    const oldestEnqueuedAt = this.#inFlightEnqueuedAtMs ?? this.#queue[0]?.enqueuedAtMs;
    return {
      queueDepth: this.#queue.length,
      inFlight: this.#processing,
      accepted: this.#accepted,
      published: this.#published,
      dropped: this.#dropped,
      failures: this.#failures,
      oldestEventAgeMs: oldestEnqueuedAt === undefined
        ? 0
        : Math.max(0, this.#now() - oldestEnqueuedAt),
      lastPublishedAt: this.#lastPublishedAt,
    };
  }

  waitForIdle(): Promise<void> {
    if (!this.#processing && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  async #drain(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      let queued: QueuedProjection | undefined;
      while ((queued = this.#queue.shift()) !== undefined) {
        this.#inFlightEnqueuedAtMs = queued.enqueuedAtMs;
        try {
          await this.sink(queued.event);
          this.#published += 1;
          this.#lastPublishedAt = new Date(this.#now()).toISOString();
        } catch (error) {
          this.#failures += 1;
          try {
            this.#onError(error);
          } catch {
            // Diagnostic callbacks cannot interrupt projection draining.
          }
        }
      }
    } finally {
      this.#inFlightEnqueuedAtMs = null;
      this.#processing = false;
      for (const resolve of this.#idleWaiters) resolve();
      this.#idleWaiters.clear();
    }
  }
}

export function tokenStatusChangedProjection(input: {
  projectionId: string;
  occurredAt: string;
  tokenEventId: string;
  mint: string;
  stage: z.infer<typeof scannerStageSchema>;
  status: z.infer<typeof scannerStatusSchema>;
  reasons?: string[];
  observationToDecisionMs?: number;
}): ProjectionEvent {
  return projectionEventSchema.parse({
    schemaVersion: 1,
    type: "token-status-changed",
    reasons: [],
    ...input,
  });
}

export function streamHealthChangedProjection(input: {
  projectionId: string;
  occurredAt: string;
  status: "connected" | "disconnected" | "compromised";
  reason: string | null;
}): ProjectionEvent {
  return projectionEventSchema.parse({
    schemaVersion: 1,
    type: "stream-health-changed",
    source: "pumpportal",
    ...input,
  });
}