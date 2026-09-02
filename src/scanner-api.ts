import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import {
  replayScannerEvents,
  type ScannerStreamHealth,
  type ScannerToken,
} from "./scanner-read-model.js";

const staticAssets = new Map([
  ["/", { file: "../public/dashboard.html", contentType: "text/html; charset=utf-8" }],
  ["/dashboard.css", { file: "../public/dashboard.css", contentType: "text/css; charset=utf-8" }],
  ["/dashboard.js", { file: "../public/dashboard.js", contentType: "text/javascript; charset=utf-8" }],
]);

const scannerQuerySchema = z.object({
  status: z.enum([
    "scanning",
    "qualified",
    "rejected",
    "monitoring",
    "skipped",
    "entered",
    "exited",
  ]).optional(),
  limit: z.coerce.number().int().positive().max(1_000).default(250),
});

interface ScannerApiSnapshot {
  generatedAt: string;
  sourceMissing: boolean;
  streams: ScannerStreamHealth[];
  observationToDecision: {
    sampleCount: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
  };
  freshness: {
    lastEventAt: string | null;
    eventAgeMs: number | null;
    staleAfterMs: number;
    stale: boolean;
  };
  tokens: ScannerToken[];
  replay: {
    validLines: number;
    invalidLines: number;
    duplicateEvents: number;
    rejectedTransitions: number;
  };
}

function percentile(sortedValues: readonly number[], percentileValue: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.max(0, Math.ceil(percentileValue * sortedValues.length) - 1);
  return sortedValues[index] ?? null;
}

export async function buildScannerApiSnapshot(
  path: string,
  now: () => Date = () => new Date(),
  staleAfterMs = 60_000,
): Promise<ScannerApiSnapshot> {
  let contents: string;
  let sourceMissing = false;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    contents = "";
    sourceMissing = true;
  }
  const replay = replayScannerEvents(contents);
  const generatedAt = now();
  const tokens = replay.model.tokens();
  const streams = replay.model.streamHealth();
  const decisionLatencySamples = tokens
    .flatMap((token) => token.timeline)
    .flatMap((entry) => entry.observationToDecisionMs === undefined
      ? []
      : [entry.observationToDecisionMs])
    .sort((left, right) => left - right);
  const lastEventAt = [...tokens.map((token) => token.updatedAt), ...streams.map((stream) => stream.updatedAt)]
    .reduce<string | null>(
    (latest, occurredAt) => latest === null || occurredAt > latest ? occurredAt : latest,
    null,
  );
  const eventAgeMs = lastEventAt === null
    ? null
    : Math.max(0, generatedAt.getTime() - Date.parse(lastEventAt));
  return {
    generatedAt: generatedAt.toISOString(),
    sourceMissing,
    streams,
    observationToDecision: {
      sampleCount: decisionLatencySamples.length,
      p50Ms: percentile(decisionLatencySamples, 0.5),
      p95Ms: percentile(decisionLatencySamples, 0.95),
      maxMs: decisionLatencySamples.at(-1) ?? null,
    },
    freshness: {
      lastEventAt,
      eventAgeMs,
      staleAfterMs,
      stale: eventAgeMs !== null && eventAgeMs > staleAfterMs,
    },
    tokens,
    replay: {
      validLines: replay.validLines,
      invalidLines: replay.invalidLines,
      duplicateEvents: replay.duplicateEvents,
      rejectedTransitions: replay.rejectedTransitions,
    },
  };
}

function sendJson(
  response: import("node:http").ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(body));
}

async function sendStatic(
  response: import("node:http").ServerResponse,
  asset: { file: string; contentType: string },
): Promise<void> {
  const contents = await readFile(new URL(asset.file, import.meta.url));
  response.writeHead(200, {
    "Content-Type": asset.contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(contents);
}

export function createScannerApiServer(
  eventLogPath: string,
  now: () => Date = () => new Date(),
  staleAfterMs = 60_000,
): Server {
  return createServer(async (request, response) => {
    try {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const asset = staticAssets.get(url.pathname);
      if (asset) {
        await sendStatic(response, asset);
        return;
      }
      const snapshot = await buildScannerApiSnapshot(eventLogPath, now, staleAfterMs);
      if (url.pathname === "/api/health") {
        sendJson(response, 200, {
          generatedAt: snapshot.generatedAt,
          sourceMissing: snapshot.sourceMissing,
          tokenCount: snapshot.tokens.length,
          streams: snapshot.streams,
          observationToDecision: snapshot.observationToDecision,
          freshness: snapshot.freshness,
          replay: snapshot.replay,
        });
        return;
      }
      if (url.pathname === "/api/scanner") {
        const query = scannerQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        if (!query.success) {
          sendJson(response, 400, { error: "Invalid scanner query." });
          return;
        }
        const filtered = query.data.status
          ? snapshot.tokens.filter((token) => token.status === query.data.status)
          : snapshot.tokens;
        sendJson(response, 200, {
          generatedAt: snapshot.generatedAt,
          sourceMissing: snapshot.sourceMissing,
          freshness: snapshot.freshness,
          streams: snapshot.streams,
          observationToDecision: snapshot.observationToDecision,
          total: filtered.length,
          tokens: filtered.slice(0, query.data.limit),
          replay: snapshot.replay,
        });
        return;
      }
      sendJson(response, 404, { error: "Not found." });
    } catch {
      sendJson(response, 500, { error: "Scanner projection unavailable." });
    }
  });
}

export async function startScannerApi(
  eventLogPath: string,
  host: "127.0.0.1" | "::1",
  port: number,
  staleAfterMs: number,
): Promise<Server> {
  const server = createScannerApiServer(eventLogPath, () => new Date(), staleAfterMs);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}