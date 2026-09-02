import assert from "node:assert/strict";
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