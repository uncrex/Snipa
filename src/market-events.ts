import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";

const publicKeySchema = z.string().refine((value) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid Solana public key");

const pumpPortalLaunchSchema = z.object({
  signature: z.string().refine((value) => {
    try {
      return bs58.decode(value).length === 64;
    } catch {
      return false;
    }
  }, "Invalid Solana transaction signature"),
  mint: publicKeySchema,
  name: z.string().optional().default("Unknown"),
  symbol: z.string().optional().default("?"),
  traderPublicKey: publicKeySchema.optional(),
  txType: z.literal("create"),
});

export const normalizedLaunchEventSchema = z.object({
  schemaVersion: z.literal(1),
  decoderVersion: z.literal("pumpportal-launch-v1"),
  eventId: z.string().min(1),
  kind: z.literal("token-created"),
  venue: z.literal("pump"),
  source: z.literal("pumpportal"),
  observedAt: z.string().datetime(),
  slot: z.number().int().nonnegative().nullable(),
  writeVersion: z.number().int().nonnegative().nullable(),
  transactionSignature: z.string().min(32),
  mint: publicKeySchema,
  name: z.string(),
  symbol: z.string(),
  actor: publicKeySchema.nullable(),
});

export type NormalizedLaunchEvent = z.infer<typeof normalizedLaunchEventSchema>;

export class EventDeduplicator {
  readonly #seen = new Set<string>();

  constructor(private readonly maxEntries = 10_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Event deduplicator capacity must be a positive safe integer.");
    }
  }

  accept(event: Pick<NormalizedLaunchEvent, "eventId">): boolean {
    if (this.#seen.has(event.eventId)) return false;
    this.#seen.add(event.eventId);
    if (this.#seen.size > this.maxEntries) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return true;
  }
}

export class StreamContinuityGuard {
  #connectedOnce = false;
  #compromised = false;

  connected(): void {
    this.#connectedOnce = true;
  }

  disconnected(): void {
    if (this.#connectedOnce) this.#compromised = true;
  }

  canEnter(): boolean {
    return this.#connectedOnce && !this.#compromised;
  }

  rejectionReason(): string | null {
    if (!this.#connectedOnce) return "Launch stream has not connected.";
    if (this.#compromised) {
      return "Launch stream disconnected without verified backfill; restart monitoring before automatic entry.";
    }
    return null;
  }
}

export function decodePumpPortalLaunchEvent(
  input: unknown,
  observedAt: string,
): NormalizedLaunchEvent {
  const source = pumpPortalLaunchSchema.parse(input);
  return normalizedLaunchEventSchema.parse({
    schemaVersion: 1,
    decoderVersion: "pumpportal-launch-v1",
    eventId: `solana:token-created:${source.signature}`,
    kind: "token-created",
    venue: "pump",
    source: "pumpportal",
    observedAt,
    slot: null,
    writeVersion: null,
    transactionSignature: source.signature,
    mint: source.mint,
    name: source.name,
    symbol: source.symbol,
    actor: source.traderPublicKey ?? null,
  });
}