import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import bs58 from "bs58";
import { decodePumpPortalLaunchEvent } from "./market-events.js";
import {
  serializeProjectionEvent,
  streamHealthChangedProjection,
  tokenDetectedProjection,
  tokenStatusChangedProjection,
} from "./projection-events.js";
import { buildScannerApiSnapshot, createScannerApiServer } from "./scanner-api.js";

const token = decodePumpPortalLaunchEvent({
  signature: bs58.encode(Buffer.alloc(64, 3)),
  mint: "So11111111111111111111111111111111111111112",
  name: "API Fixture",
  symbol: "API",
  txType: "create",
}, "2026-08-31T12:00:00.000Z");
const detected = tokenDetectedProjection(token);
const rejected = tokenStatusChangedProjection({
  projectionId: "dashboard:api-rejected",
  occurredAt: "2026-08-31T12:00:01.000Z",
  tokenEventId: token.eventId,
  mint: token.mint,
  stage: "decision",
  status: "rejected",
  reasons: ["Holder concentration exceeds limit"],
  observationToDecisionMs: 25,
});

test("scanner API snapshot replays projection logs without secrets", async (context) => {
  const path = join(tmpdir(), `snipa-scanner-${process.pid}-${Date.now()}.jsonl`);
  context.after(() => rm(path, { force: true }));
  await writeFile(path, `${serializeProjectionEvent(detected)}${serializeProjectionEvent(rejected)}`);
  const snapshot = await buildScannerApiSnapshot(
    path,
    () => new Date("2026-08-31T12:00:02.000Z"),
  );

  assert.equal(snapshot.tokens[0]?.status, "rejected");
  assert.deepEqual(snapshot.tokens[0]?.reasons, ["Holder concentration exceeds limit"]);
  assert.deepEqual(snapshot.freshness, {
    lastEventAt: "2026-08-31T12:00:01.000Z",
    eventAgeMs: 1_000,
    staleAfterMs: 60_000,
    stale: false,
  });
  assert.deepEqual(snapshot.observationToDecision, {
    sampleCount: 1,
    p50Ms: 25,
    p95Ms: 25,
    maxMs: 25,
  });
  assert.equal(JSON.stringify(snapshot).includes("privateKey"), false);
  assert.equal(JSON.stringify(snapshot).includes("SOLANA_PRIVATE_KEY"), false);
});

test("scanner HTTP API filters tokens and exposes replay health", async (context) => {
  const path = join(tmpdir(), `snipa-scanner-http-${process.pid}-${Date.now()}.jsonl`);
  context.after(() => rm(path, { force: true }));
  await writeFile(path, `${serializeProjectionEvent(detected)}${serializeProjectionEvent(rejected)}`);
  const server = createScannerApiServer(path, () => new Date("2026-08-31T12:00:02.000Z"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const dashboardResponse = await fetch(baseUrl);
  assert.equal(dashboardResponse.status, 200);
  assert.match(dashboardResponse.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await dashboardResponse.text(), /<h1 id="scanner-heading">Token scanner<\/h1>/);
  assert.match(
    dashboardResponse.headers.get("content-security-policy") ?? "",
    /script-src 'self'/,
  );

  const scannerResponse = await fetch(`${baseUrl}/api/scanner?status=rejected&limit=1`);
  assert.equal(scannerResponse.status, 200);
  assert.equal(scannerResponse.headers.get("cache-control"), "no-store");
  const scanner = await scannerResponse.json() as {
    total: number;
    observationToDecision: { sampleCount: number; p95Ms: number | null };
    tokens: Array<{ status: string }>;
  };
  assert.equal(scanner.total, 1);
  assert.equal(scanner.tokens[0]?.status, "rejected");
  assert.deepEqual(scanner.observationToDecision, {
    sampleCount: 1,
    p50Ms: 25,
    p95Ms: 25,
    maxMs: 25,
  });

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  const health = await healthResponse.json() as {
    tokenCount: number;
    observationToDecision: { sampleCount: number; p95Ms: number | null };
    replay: { validLines: number };
  };
  assert.equal(health.tokenCount, 1);
  assert.deepEqual(health.observationToDecision, {
    sampleCount: 1,
    p50Ms: 25,
    p95Ms: 25,
    maxMs: 25,
  });
  assert.equal(health.replay.validLines, 2);
  assert.equal((await fetch(`${baseUrl}/api/scanner`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${baseUrl}/api/scanner?limit=1001`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/unknown`)).status, 404);
});

test("manual paper buys require fresh same-origin commands and execute once", async (context) => {
  const path = join(tmpdir(), `snipa-scanner-buy-${process.pid}-${Date.now()}.jsonl`);
  context.after(() => rm(path, { force: true }));
  await writeFile(path, serializeProjectionEvent(detected));
  const executions: Array<{ mint: string; amountSol: number }> = [];
  const csrfToken = "test-csrf-token";
  const server = createScannerApiServer(
    path,
    () => new Date("2026-08-31T12:00:02.000Z"),
    60_000,
    {
      maxAmountSol: 0.01,
      execute: async (mint, amountSol) => { executions.push({ mint, amountSol }); },
    },
    csrfToken,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const command = {
    commandId: randomUUID(),
    createdAt: "2026-08-31T12:00:02.000Z",
    mint: token.mint,
    amountSol: 0.005,
  };
  const submit = (body: typeof command, origin = baseUrl) => fetch(`${baseUrl}/api/manual-buy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "X-Snipa-CSRF": csrfToken,
    },
    body: JSON.stringify(body),
  });

  assert.equal((await submit(command)).status, 200);
  assert.equal((await submit(command)).status, 200);
  assert.deepEqual(executions, [{ mint: token.mint, amountSol: 0.005 }]);
  assert.equal((await submit({ ...command, amountSol: 0.006 })).status, 409);
  assert.equal((await submit({
    ...command,
    commandId: randomUUID(),
    createdAt: "2026-08-31T11:59:00.000Z",
  })).status, 400);
  assert.equal((await submit({ ...command, commandId: randomUUID() }, "http://evil.invalid")).status, 403);
  assert.equal(executions.length, 1);
});

test("token market data is limited to scanner mints and cached briefly", async (context) => {
  const path = join(tmpdir(), `snipa-scanner-market-${process.pid}-${Date.now()}.jsonl`);
  context.after(() => rm(path, { force: true }));
  await writeFile(path, serializeProjectionEvent(detected));
  let requests = 0;
  const server = createScannerApiServer(
    path,
    () => new Date("2026-08-31T12:00:02.000Z"),
    60_000,
    undefined,
    "test-csrf-token",
    async () => {
      requests += 1;
      return {
        generatedAt: "2026-08-31T12:00:02.000Z",
        pool: {
          address: "Pool111111111111111111111111111111111111111",
          name: "API / SOL",
          dex: "pumpswap",
          priceUsd: 0.001,
          liquidityUsd: 50_000,
          volume24hUsd: 12_000,
          change24hPercent: 4.2,
          activeTraders5m: 8,
          buys5m: 8,
          sells5m: 3,
        },
        candles: [{ timestamp: 1_788_372_000, open: 0.0009, high: 0.0011, low: 0.0008, close: 0.001, volumeUsd: 500 }],
        trades: [{ timestamp: "2026-08-31T12:00:01Z", signature: "signature", wallet: "wallet", side: "buy", volumeUsd: 25, fromAmount: 0.25, toAmount: 25_000, fromPriceUsd: 100, toPriceUsd: 0.001 }],
      };
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const first = await fetch(`${baseUrl}/api/token-market?mint=${token.mint}`);
  const second = await fetch(`${baseUrl}/api/token-market?mint=${token.mint}`);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await first.json() as { pool: { dex: string } }).pool.dex, "pumpswap");
  assert.equal(requests, 1);
  assert.equal((await fetch(`${baseUrl}/api/token-market?mint=11111111111111111111111111111111`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/token-market?mint=not-a-mint`)).status, 400);
});

test("market caps cover scanner mints and cache the batch response", async (context) => {
  const path = join(tmpdir(), `snipa-scanner-caps-${process.pid}-${Date.now()}.jsonl`);
  context.after(() => rm(path, { force: true }));
  const detections = Array.from({ length: 91 }, (_, index) => tokenDetectedProjection(
    decodePumpPortalLaunchEvent({
      signature: bs58.encode(Buffer.alloc(64, index + 1)),
      mint: bs58.encode(Buffer.alloc(32, index + 1)),
      name: `Market fixture ${index}`,
      symbol: `M${index}`,
      txType: "create",
    }, new Date(Date.parse("2026-08-31T12:00:00.000Z") + index).toISOString()),
  ));
  await writeFile(path, detections.map(serializeProjectionEvent).join(""));
  const expectedMints = detections
    .slice(1)
    .reverse()
    .map((event) => {
      assert.equal(event.type, "token-detected");
      return event.type === "token-detected" ? event.token.mint : "";
    });
  let requests = 0;
  const server = createScannerApiServer(
    path,
    () => new Date("2026-08-31T12:00:02.000Z"),
    60_000,
    undefined,
    "test-csrf-token",
    undefined,
    undefined,
    async (mints) => {
      requests += 1;
      assert.deepEqual(mints, expectedMints);
      return [{
        mint: expectedMints[0]!,
        marketCapUsd: 25_000,
        priceUsd: 0.000025,
        liquidityUsd: 8_000,
        pairAddress: "pair",
      }];
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const first = await fetch(`${baseUrl}/api/market-caps`);
  const second = await fetch(`${baseUrl}/api/market-caps`);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstBody = await first.json() as { coverageLimit: number; tokens: unknown[] };
  assert.equal(firstBody.coverageLimit, 90);
  assert.deepEqual(firstBody.tokens, [{
    mint: expectedMints[0],
    marketCapUsd: 25_000,
    priceUsd: 0.000025,
    liquidityUsd: 8_000,
    pairAddress: "pair",
  }]);
  assert.equal(requests, 1);
});

test("token activity covers scanner mints and caches the batch response", async (context) => {
  const path = join(tmpdir(), `snipa-scanner-activity-${process.pid}-${Date.now()}.jsonl`);
  context.after(() => rm(path, { force: true }));
  await writeFile(path, serializeProjectionEvent(detected));
  let requests = 0;
  const server = createScannerApiServer(
    path,
    () => new Date("2026-08-31T12:00:02.000Z"),
    60_000,
    undefined,
    "test-csrf-token",
    undefined,
    undefined,
    undefined,
    async (mints) => {
      requests += 1;
      assert.deepEqual(mints, [token.mint]);
      return [{
        mint: token.mint,
        activeTraders5m: 8,
        buyPressurePercent: 80,
        volumeAcceleration: 3,
      }];
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const first = await fetch(`${baseUrl}/api/token-activity`);
  const second = await fetch(`${baseUrl}/api/token-activity`);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual((await first.json() as { tokens: unknown[] }).tokens, [{
    mint: token.mint,
    activeTraders5m: 8,
    buyPressurePercent: 80,
    volumeAcceleration: 3,
  }]);
  assert.equal(requests, 1);
});

test("holder concentration covers scanner mints and caches the batch response", async (context) => {
  const path = join(tmpdir(), `snipa-scanner-holders-${process.pid}-${Date.now()}.jsonl`);
  context.after(() => rm(path, { force: true }));
  await writeFile(path, serializeProjectionEvent(detected));
  let requests = 0;
  const server = createScannerApiServer(
    path,
    () => new Date("2026-08-31T12:00:02.000Z"),
    60_000,
    undefined,
    "test-csrf-token",
    undefined,
    undefined,
    undefined,
    undefined,
    async (mints) => {
      requests += 1;
      assert.deepEqual(mints, [token.mint]);
      return [{ mint: token.mint, top10HolderPercent: 42.5 }];
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const first = await fetch(`${baseUrl}/api/holder-concentration`);
  const second = await fetch(`${baseUrl}/api/holder-concentration`);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual((await first.json() as { tokens: unknown[] }).tokens, [{
    mint: token.mint,
    top10HolderPercent: 42.5,
  }]);
  assert.equal(requests, 1);
});

test("wallet status exposes public details without signing material", async (context) => {
  const path = join(tmpdir(), `snipa-scanner-wallet-${process.pid}-${Date.now()}.jsonl`);
  const server = createScannerApiServer(
    path,
    undefined,
    undefined,
    { maxAmountSol: 0.01, execute: async () => undefined },
    "test-csrf-token",
    async () => { throw new Error("Market provider should not be called."); },
    { inspect: async () => ({ address: token.mint, balanceSol: 1.25 }) },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");

  const response = await fetch(`http://127.0.0.1:${address.port}/api/wallet`);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.deepEqual(body, { address: token.mint, balanceSol: 1.25, mode: "paper" });
  assert.equal(JSON.stringify(body).includes("private"), false);
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("missing projection logs produce an explicit empty snapshot", async () => {
  const snapshot = await buildScannerApiSnapshot(join(tmpdir(), "snipa-missing-projection.jsonl"));
  assert.equal(snapshot.sourceMissing, true);
  assert.deepEqual(snapshot.freshness, {
    lastEventAt: null,
    eventAgeMs: null,
    staleAfterMs: 60_000,
    stale: false,
  });
  assert.deepEqual(snapshot.tokens, []);
  assert.deepEqual(snapshot.observationToDecision, {
    sampleCount: 0,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
  });
});

test("projection freshness becomes stale only after the configured threshold", async (context) => {
  const path = join(tmpdir(), `snipa-scanner-stale-${process.pid}-${Date.now()}.jsonl`);
  context.after(() => rm(path, { force: true }));
  await writeFile(path, serializeProjectionEvent(detected));

  const boundary = await buildScannerApiSnapshot(
    path,
    () => new Date("2026-08-31T12:00:05.000Z"),
    5_000,
  );
  const stale = await buildScannerApiSnapshot(
    path,
    () => new Date("2026-08-31T12:00:05.001Z"),
    5_000,
  );

  assert.equal(boundary.freshness.stale, false);
  assert.equal(stale.freshness.stale, true);
  assert.equal(stale.freshness.eventAgeMs, 5_001);
});

test("scanner API snapshot exposes replayed stream continuity state", async (context) => {
  const path = join(tmpdir(), `snipa-scanner-stream-${process.pid}-${Date.now()}.jsonl`);
  context.after(() => rm(path, { force: true }));
  const disconnected = streamHealthChangedProjection({
    projectionId: "dashboard:api-stream-disconnected",
    occurredAt: "2026-08-31T12:00:03.000Z",
    status: "disconnected",
    reason: "PumpPortal WebSocket closed.",
  });
  await writeFile(path, serializeProjectionEvent(disconnected));

  const snapshot = await buildScannerApiSnapshot(
    path,
    () => new Date("2026-08-31T12:00:04.000Z"),
  );
  assert.deepEqual(snapshot.streams, [{
    source: "pumpportal",
    status: "disconnected",
    updatedAt: "2026-08-31T12:00:03.000Z",
    reason: "PumpPortal WebSocket closed.",
  }]);
  assert.equal(snapshot.freshness.lastEventAt, "2026-08-31T12:00:03.000Z");
  assert.equal(snapshot.replay.validLines, 1);
});