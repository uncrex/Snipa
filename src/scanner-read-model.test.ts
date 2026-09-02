import assert from "node:assert/strict";
import { test } from "node:test";
import bs58 from "bs58";
import { decodePumpPortalLaunchEvent } from "./market-events.js";
import {
  streamHealthChangedProjection,
  tokenDetectedProjection,
  tokenStatusChangedProjection,
} from "./projection-events.js";
import { replayScannerEvents, ScannerReadModel } from "./scanner-read-model.js";

const token = decodePumpPortalLaunchEvent({
  signature: bs58.encode(Buffer.alloc(64, 2)),
  mint: "So11111111111111111111111111111111111111112",
  name: "Scanner Fixture",
  symbol: "SCAN",
  txType: "create",
}, "2026-08-31T12:00:00.000Z");
const detected = tokenDetectedProjection(token);

test("scanner model applies lifecycle updates and preserves exact rejection reasons", () => {
  const model = new ScannerReadModel();
  model.apply(detected);
  model.apply(tokenStatusChangedProjection({
    projectionId: "dashboard:rejected:fixture",
    occurredAt: "2026-08-31T12:00:01.000Z",
    tokenEventId: token.eventId,
    mint: token.mint,
    stage: "decision",
    status: "rejected",
    reasons: ["Top-10 concentration 24.1% exceeds 20%"],
    observationToDecisionMs: 25,
  }));

  assert.deepEqual(model.tokens(), [{
    tokenEventId: token.eventId,
    mint: token.mint,
    name: "Scanner Fixture",
    symbol: "SCAN",
    venue: "pump",
    detectedAt: "2026-08-31T12:00:00.000Z",
    updatedAt: "2026-08-31T12:00:01.000Z",
    stage: "decision",
    status: "rejected",
    reasons: ["Top-10 concentration 24.1% exceeds 20%"],
    timeline: [{
      projectionId: detected.projectionId,
      type: "token-detected",
      occurredAt: "2026-08-31T12:00:00.000Z",
      stage: "detected",
      status: "scanning",
      reasons: [],
    }, {
      projectionId: "dashboard:rejected:fixture",
      type: "token-status-changed",
      occurredAt: "2026-08-31T12:00:01.000Z",
      stage: "decision",
      status: "rejected",
      reasons: ["Top-10 concentration 24.1% exceeds 20%"],
      observationToDecisionMs: 25,
    }],
  }]);
});

test("scanner replay is idempotent and reports malformed or invalid transitions", () => {
  const rejected = tokenStatusChangedProjection({
    projectionId: "dashboard:rejected:fixture",
    occurredAt: "2026-08-31T12:00:01.000Z",
    tokenEventId: token.eventId,
    mint: token.mint,
    stage: "decision",
    status: "rejected",
    reasons: ["Liquidity below minimum"],
  });
  const regressed = tokenStatusChangedProjection({
    projectionId: "dashboard:regressed:fixture",
    occurredAt: "2026-08-31T12:00:02.000Z",
    tokenEventId: token.eventId,
    mint: token.mint,
    stage: "token-safety",
    status: "scanning",
  });
  const replay = replayScannerEvents([
    JSON.stringify(detected),
    JSON.stringify(detected),
    JSON.stringify(rejected),
    JSON.stringify(regressed),
    "not-json",
  ].join("\n"));

  assert.equal(replay.validLines, 2);
  assert.equal(replay.duplicateEvents, 1);
  assert.equal(replay.rejectedTransitions, 1);
  assert.equal(replay.invalidLines, 1);
  assert.equal(replay.model.tokens()[0]?.status, "rejected");
  assert.deepEqual(
    replay.model.tokens()[0]?.timeline.map((entry) => entry.projectionId),
    [detected.projectionId, rejected.projectionId],
  );
});

test("scanner token snapshots cannot mutate the stored lifecycle timeline", () => {
  const model = new ScannerReadModel();
  model.apply(detected);
  const snapshot = model.tokens()[0];
  if (!snapshot) throw new Error("Expected scanner token snapshot.");

  snapshot.timeline[0]?.reasons.push("external mutation");
  snapshot.timeline.push({
    projectionId: "external",
    type: "token-status-changed",
    occurredAt: snapshot.updatedAt,
    stage: snapshot.stage,
    status: snapshot.status,
    reasons: [],
  });

  assert.equal(model.tokens()[0]?.timeline.length, 1);
  assert.deepEqual(model.tokens()[0]?.timeline[0]?.reasons, []);
});

test("scanner model rejects unknown tokens, mint mismatch, and reasonless rejection", () => {
  assert.throws(() => tokenStatusChangedProjection({
    projectionId: "dashboard:reasonless",
    occurredAt: "2026-08-31T12:00:01.000Z",
    tokenEventId: token.eventId,
    mint: token.mint,
    stage: "decision",
    status: "rejected",
  }), /requires at least one exact reason/);

  const model = new ScannerReadModel();
  const unknown = tokenStatusChangedProjection({
    projectionId: "dashboard:unknown",
    occurredAt: "2026-08-31T12:00:01.000Z",
    tokenEventId: "unknown",
    mint: token.mint,
    stage: "decision",
    status: "qualified",
  });
  assert.throws(() => model.apply(unknown), /unknown token/);
  model.apply(detected);
  assert.throws(
    () => model.apply({
      ...unknown,
      projectionId: "dashboard:mismatched-mint",
      tokenEventId: token.eventId,
      mint: "11111111111111111111111111111111",
    }),
    /mint does not match/,
  );
});

test("scanner model cannot rewrite a terminal decision", () => {
  const model = new ScannerReadModel();
  model.apply(detected);
  model.apply(tokenStatusChangedProjection({
    projectionId: "dashboard:terminal-rejection",
    occurredAt: "2026-08-31T12:00:01.000Z",
    tokenEventId: token.eventId,
    mint: token.mint,
    stage: "decision",
    status: "rejected",
    reasons: ["Freeze authority remains enabled"],
  }));
  assert.throws(() => model.apply(tokenStatusChangedProjection({
    projectionId: "dashboard:rewrite-terminal",
    occurredAt: "2026-08-31T12:00:02.000Z",
    tokenEventId: token.eventId,
    mint: token.mint,
    stage: "decision",
    status: "qualified",
  })), /Invalid scanner status transition from rejected to qualified/);
});

test("scanner model replays latest stream health and rejects time regression", () => {
  const model = new ScannerReadModel();
  model.apply(streamHealthChangedProjection({
    projectionId: "dashboard:stream:connected",
    occurredAt: "2026-08-31T12:00:00.000Z",
    status: "connected",
    reason: null,
  }));
  model.apply(streamHealthChangedProjection({
    projectionId: "dashboard:stream:disconnected",
    occurredAt: "2026-08-31T12:00:02.000Z",
    status: "disconnected",
    reason: "PumpPortal WebSocket closed.",
  }));

  assert.deepEqual(model.streamHealth(), [{
    source: "pumpportal",
    status: "disconnected",
    updatedAt: "2026-08-31T12:00:02.000Z",
    reason: "PumpPortal WebSocket closed.",
  }]);
  assert.throws(() => model.apply(streamHealthChangedProjection({
    projectionId: "dashboard:stream:regressed",
    occurredAt: "2026-08-31T12:00:01.000Z",
    status: "connected",
    reason: null,
  })), /Stream health time regressed/);
});