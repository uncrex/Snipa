import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import type { DashboardCommandAudit, DashboardCommandEntry } from "./dashboard-command-audit.js";
import { fetchTokenActivity, type TokenActivity } from "./token-activity.js";
import type { TokenHolderConcentration } from "./token-holder-concentration.js";
import { fetchTokenMarketData, type TokenMarketData } from "./token-market-data.js";
import { fetchTokenMarketCaps, type TokenMarketCap } from "./token-market-caps.js";
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
const MARKET_CAP_COVERAGE_LIMIT = 90;

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

  const tokenMarketQuerySchema = z.object({
    mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  });

const manualBuySchema = z.object({
  commandId: z.string().uuid(),
  createdAt: z.string().datetime(),
  mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  amountSol: z.number().positive().max(1),
});

export interface ScannerManualBuyControl {
  mode?: "paper" | "live";
  maxAmountSol: number;
  maxCommandAgeMs?: number;
  minCommandIntervalMs?: number;
  authorize?: () => Promise<void>;
  audit?: DashboardCommandAudit;
  execute: (mint: string, amountSol: number, commandId: string) => Promise<string | void>;
}

  export type TokenMarketDataProvider = (mint: string) => Promise<TokenMarketData>;
  export type TokenMarketCapsProvider = (mints: readonly string[]) => Promise<TokenMarketCap[]>;
  export type TokenActivityProvider = (mints: readonly string[]) => Promise<TokenActivity[]>;
  export type TokenHolderConcentrationProvider = (
    mints: readonly string[],
  ) => Promise<TokenHolderConcentration[]>;

  export interface ScannerWalletControl {
    inspect: () => Promise<{ address: string; balanceSol: number }>;
  }

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

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 4_096) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
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
  manualBuy?: ScannerManualBuyControl,
  csrfToken = randomBytes(32).toString("base64url"),
  marketDataProvider: TokenMarketDataProvider = fetchTokenMarketData,
  wallet?: ScannerWalletControl,
  marketCapsProvider: TokenMarketCapsProvider = fetchTokenMarketCaps,
  activityProvider: TokenActivityProvider = fetchTokenActivity,
  holderConcentrationProvider?: TokenHolderConcentrationProvider,
): Server {
  const manualBuyCommands = new Map<string, {
    mint: string;
    amountSol: number;
    execution: Promise<DashboardCommandEntry>;
  }>();
  let lastManualBuyAtMs = Number.NEGATIVE_INFINITY;
  const marketDataCache = new Map<string, { expiresAt: number; value: Promise<TokenMarketData> }>();
  let marketCapsCache: {
    mintKey: string;
    expiresAt: number;
    value: Promise<TokenMarketCap[]>;
  } | undefined;
  let activityCache: {
    mintKey: string;
    expiresAt: number;
    value: Promise<TokenActivity[]>;
  } | undefined;
  let holderConcentrationCache: {
    mintKey: string;
    expiresAt: number;
    value: Promise<TokenHolderConcentration[]>;
  } | undefined;
  const mode = manualBuy?.mode ?? "paper";
  const liveControlReady = mode === "paper" || Boolean(manualBuy?.authorize && manualBuy.audit);
  const sendCommand = (
    response: import("node:http").ServerResponse,
    entry: DashboardCommandEntry,
  ): void => {
    sendJson(response, entry.status === "rejected" ? 422 : 200, {
      commandId: entry.commandId,
      status: entry.status,
      mode: entry.mode,
      mint: entry.mint,
      amountSol: entry.amountSol,
      signature: entry.signature,
      error: entry.error,
    });
  };
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "POST" && url.pathname === "/api/manual-buy") {
        const expectedOrigin = `http://${request.headers.host}`;
        if (request.headers.origin !== expectedOrigin
          || request.headers["x-snipa-csrf"] !== csrfToken) {
          sendJson(response, 403, { error: "Manual buy request failed origin or CSRF validation." });
          return;
        }
        if (!manualBuy || !liveControlReady) {
          sendJson(response, 503, { error: "Dashboard manual buy control is not safely configured." });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch {
          sendJson(response, 400, { error: "Invalid manual buy request." });
          return;
        }
        const parsed = manualBuySchema.safeParse(body);
        if (!parsed.success) {
          sendJson(response, 400, { error: "Invalid manual buy request." });
          return;
        }
        const input = parsed.data;
        const commandAgeMs = now().getTime() - Date.parse(input.createdAt);
        if (commandAgeMs < -5_000 || commandAgeMs > (manualBuy.maxCommandAgeMs ?? 30_000)) {
          sendJson(response, 400, { error: "Manual buy command has expired." });
          return;
        }
        if (input.amountSol > manualBuy.maxAmountSol) {
          sendJson(response, 400, {
            error: `Buy amount exceeds the ${manualBuy.maxAmountSol} SOL limit.`,
          });
          return;
        }
        const snapshot = await buildScannerApiSnapshot(eventLogPath, now, staleAfterMs);
        if (!snapshot.tokens.some((token) => token.mint === input.mint)) {
          sendJson(response, 404, { error: "Manual buy mint is not present in the scanner." });
          return;
        }
        const audited = await manualBuy.audit?.get(input.commandId);
        if (audited && (
          audited.createdAt !== input.createdAt
          || audited.mint !== input.mint
          || audited.amountSol !== input.amountSol
          || audited.mode !== mode
        )) {
          sendJson(response, 409, { error: "Manual buy command ID conflicts with an earlier command." });
          return;
        }
        if (audited && audited.status !== "accepted") {
          sendCommand(response, audited);
          return;
        }
        let command = manualBuyCommands.get(input.commandId);
        if (command && (command.mint !== input.mint || command.amountSol !== input.amountSol)) {
          sendJson(response, 409, { error: "Manual buy command ID conflicts with an earlier command." });
          return;
        }
        if (audited && !command) {
          sendJson(response, 409, {
            commandId: input.commandId,
            status: "indeterminate",
            error: "Command was accepted before restart; inspect the trade journal before retrying.",
          });
          return;
        }
        if (!command) {
          const acceptedAtMs = now().getTime();
          if (acceptedAtMs - lastManualBuyAtMs < (manualBuy.minCommandIntervalMs ?? 1_000)) {
            sendJson(response, 429, { error: "Manual buy rate limit exceeded." });
            return;
          }
          lastManualBuyAtMs = acceptedAtMs;
          const accepted: DashboardCommandEntry = {
            schemaVersion: 1,
            commandId: input.commandId,
            createdAt: input.createdAt,
            timestamp: now().toISOString(),
            mint: input.mint,
            amountSol: input.amountSol,
            mode,
            status: "accepted",
            signature: null,
            error: null,
          };
          await manualBuy.audit?.append(accepted);
          const execution = (async () => {
            try {
              await manualBuy.authorize?.();
              const signature = await manualBuy.execute(input.mint, input.amountSol, input.commandId);
              if (mode === "live" && !signature) {
                throw new Error("Live trade completed without a transaction signature.");
              }
              const completed: DashboardCommandEntry = {
                ...accepted,
                timestamp: now().toISOString(),
                status: mode === "live" ? "confirmed" : "paper",
                signature: signature ?? null,
              };
              await manualBuy.audit?.append(completed);
              return completed;
            } catch (error) {
              const rejected: DashboardCommandEntry = {
                ...accepted,
                timestamp: now().toISOString(),
                status: "rejected",
                error: error instanceof Error ? error.message : "Manual buy was rejected.",
              };
              await manualBuy.audit?.append(rejected);
              return rejected;
            }
          })();
          command = { mint: input.mint, amountSol: input.amountSol, execution };
          manualBuyCommands.set(input.commandId, command);
          if (manualBuyCommands.size > 100) {
            manualBuyCommands.delete(manualBuyCommands.keys().next().value!);
          }
        }
        sendCommand(response, await command.execution);
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, POST");
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }
      const asset = staticAssets.get(url.pathname);
      if (asset) {
        await sendStatic(response, asset);
        return;
      }
      if (url.pathname === "/api/wallet") {
        if (!wallet) {
          sendJson(response, 503, { error: "Local wallet is not configured for the dashboard." });
          return;
        }
        try {
          const publicWallet = await wallet.inspect();
          sendJson(response, 200, { ...publicWallet, mode });
        } catch (error) {
          sendJson(response, 503, {
            error: error instanceof Error ? error.message : "Local wallet is unavailable.",
          });
        }
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
      if (url.pathname === "/api/control") {
        sendJson(response, 200, {
          csrfToken,
          manualBuy: manualBuy && liveControlReady
            ? { enabled: true, mode, maxAmountSol: manualBuy.maxAmountSol }
            : { enabled: false, mode: "unavailable", maxAmountSol: null },
          wallet: { available: Boolean(wallet), custody: "local" },
        });
        return;
      }
      if (url.pathname === "/api/token-market") {
        const query = tokenMarketQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        if (!query.success) {
          sendJson(response, 400, { error: "Invalid token market query." });
          return;
        }
        if (!snapshot.tokens.some((token) => token.mint === query.data.mint)) {
          sendJson(response, 404, { error: "Token mint is not present in the scanner." });
          return;
        }
        let cached = marketDataCache.get(query.data.mint);
        if (!cached || cached.expiresAt <= now().getTime()) {
          cached = {
            expiresAt: now().getTime() + 15_000,
            value: marketDataProvider(query.data.mint),
          };
          marketDataCache.set(query.data.mint, cached);
        }
        try {
          sendJson(response, 200, await cached.value);
        } catch (error) {
          marketDataCache.delete(query.data.mint);
          sendJson(response, 502, {
            error: error instanceof Error ? error.message : "Live market data is unavailable.",
          });
        }
        return;
      }
      if (url.pathname === "/api/market-caps") {
        const mints = [...new Set([...snapshot.tokens]
          .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
          .map((token) => token.mint))]
          .slice(0, MARKET_CAP_COVERAGE_LIMIT);
        const mintKey = [...mints].sort().join(",");
        if (!marketCapsCache
          || marketCapsCache.mintKey !== mintKey
          || marketCapsCache.expiresAt <= now().getTime()) {
          marketCapsCache = {
            mintKey,
            expiresAt: now().getTime() + 60_000,
            value: marketCapsProvider(mints),
          };
        }
        try {
          sendJson(response, 200, {
            generatedAt: now().toISOString(),
            coverageLimit: MARKET_CAP_COVERAGE_LIMIT,
            tokens: await marketCapsCache.value,
          });
        } catch (error) {
          marketCapsCache = undefined;
          sendJson(response, 502, {
            error: error instanceof Error ? error.message : "Live market caps are unavailable.",
          });
        }
        return;
      }
      if (url.pathname === "/api/token-activity") {
        const mints = [...new Set([...snapshot.tokens]
          .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
          .map((token) => token.mint))]
          .slice(0, 30);
        const mintKey = [...mints].sort().join(",");
        if (!activityCache
          || activityCache.mintKey !== mintKey
          || activityCache.expiresAt <= now().getTime()) {
          activityCache = {
            mintKey,
            expiresAt: now().getTime() + 60_000,
            value: activityProvider(mints),
          };
        }
        try {
          sendJson(response, 200, {
            generatedAt: now().toISOString(),
            coverageLimit: 30,
            tokens: await activityCache.value,
          });
        } catch (error) {
          activityCache = undefined;
          sendJson(response, 502, {
            error: error instanceof Error ? error.message : "Token activity is unavailable.",
          });
        }
        return;
      }
      if (url.pathname === "/api/holder-concentration") {
        if (!holderConcentrationProvider) {
          sendJson(response, 503, { error: "Holder concentration is unavailable." });
          return;
        }
        const mints = [...new Set([...snapshot.tokens]
          .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
          .map((token) => token.mint))]
          .slice(0, 5);
        const mintKey = [...mints].sort().join(",");
        if (!holderConcentrationCache
          || holderConcentrationCache.mintKey !== mintKey
          || holderConcentrationCache.expiresAt <= now().getTime()) {
          holderConcentrationCache = {
            mintKey,
            expiresAt: now().getTime() + 300_000,
            value: holderConcentrationProvider(mints),
          };
        }
        try {
          sendJson(response, 200, {
            generatedAt: now().toISOString(),
            coverageLimit: 5,
            tokens: await holderConcentrationCache.value,
          });
        } catch (error) {
          holderConcentrationCache = undefined;
          sendJson(response, 502, {
            error: error instanceof Error ? error.message : "Holder concentration is unavailable.",
          });
        }
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
  manualBuy?: ScannerManualBuyControl,
  wallet?: ScannerWalletControl,
  marketCapsProvider?: TokenMarketCapsProvider,
  activityProvider?: TokenActivityProvider,
  holderConcentrationProvider?: TokenHolderConcentrationProvider,
): Promise<Server> {
  const server = createScannerApiServer(
    eventLogPath,
    () => new Date(),
    staleAfterMs,
    manualBuy,
    undefined,
    undefined,
    wallet,
    marketCapsProvider,
    activityProvider,
    holderConcentrationProvider,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}