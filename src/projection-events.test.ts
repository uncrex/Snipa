import assert from "node:assert/strict";
import { test } from "node:test";
import bs58 from "bs58";
import { decodePumpPortalLaunchEvent } from "./market-events.js";
import {
  AsyncProjectionPublisher,
  serializeProjectionEvent,
  streamHealthChangedProjection,
  tokenDetectedProjection,
  tokenStatusChangedProjection,
  type ProjectionEvent,
} from "./projection-events.js";

function fixture(): Extract<ProjectionEvent, { type: "token-detected" }> {
  const event = tokenDetectedProjection(decodePumpPortalLaunchEvent({
    signature: bs58.encode(Buffer.alloc(64, 1)),
    mint: "So11111111111111111111111111111111111111112",
    txType: "create",
  }, "2026-08-31T12:00:00.000Z"));
  if (event.type !== "token-detected") throw new Error("Expected token detection.");
  return event;
}

test("token detections produce deterministic scanning projections", () => {
  const event = fixture();
  assert.equal(event.stage, "detected");
  assert.equal(event.status, "scanning");
  assert.deepEqual(JSON.parse(serializeProjectionEvent(event)), event);
});

test("decision projections accept only decision-stage observation latency", () => {
  const detected = fixture();
  if (detected.type !== "token-detected") throw new Error("Expected token fixture.");
  const decision = tokenStatusChangedProjection({
    projectionId: "dashboard:decision-latency",
    occurredAt: "2026-08-31T12:00:00.025Z",
    tokenEventId: detected.token.eventId,
    mint: detected.token.mint,
    stage: "decision",
    status: "monitoring",
    reasons: ["Automatic buying is disabled."],
    observationToDecisionMs: 25,
  });

  assert.equal(
    decision.type === "token-status-changed" ? decision.observationToDecisionMs : undefined,
    25,
  );
  assert.throws(() => tokenStatusChangedProjection({
    projectionId: "dashboard:position-latency",
    occurredAt: "2026-08-31T12:00:00.025Z",
    tokenEventId: detected.token.eventId,
    mint: detected.token.mint,
    stage: "position",
    status: "entered",
    observationToDecisionMs: 25,
  }), /valid only for decision-stage events/);
});

test("stream health projections require exact failure reasons", () => {
  const disconnected = streamHealthChangedProjection({
    projectionId: "dashboard:stream-health:disconnected",
    occurredAt: "2026-08-31T12:00:01.000Z",
    status: "disconnected",
    reason: "PumpPortal WebSocket closed.",
  });
  assert.equal(disconnected.type, "stream-health-changed");
  assert.throws(() => streamHealthChangedProjection({
    projectionId: "dashboard:stream-health:reasonless",
    occurredAt: "2026-08-31T12:00:01.000Z",
    status: "compromised",
    reason: null,
  }), /requires an exact reason/);
  assert.throws(() => streamHealthChangedProjection({
    projectionId: "dashboard:stream-health:connected-with-error",
    occurredAt: "2026-08-31T12:00:01.000Z",
    status: "connected",
    reason: "Unexpected reason.",
  }), /cannot include a failure reason/);
});

test("projection publishing is non-blocking and reports bounded queue drops", async () => {
  const received: ProjectionEvent[] = [];
  let releaseSink: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    releaseSink = resolve;
  });
  const publisher = new AsyncProjectionPublisher(async (event) => {
    received.push(event);
    if (received.length === 1) await blocked;
  }, 1, { now: () => 1_000 });
  const first = fixture();
  const second = { ...fixture(), projectionId: "dashboard:second" };
  const third = { ...fixture(), projectionId: "dashboard:third" };

  assert.equal(publisher.publish(first), true);
  assert.equal(publisher.publish(second), true);
  assert.equal(publisher.publish(third), false);
  assert.deepEqual(publisher.health(), {
    queueDepth: 1,
    inFlight: true,
    accepted: 2,
    published: 0,
    dropped: 1,
    failures: 0,
    oldestEventAgeMs: 0,
    lastPublishedAt: null,
  });

  releaseSink?.();
  await publisher.waitForIdle();
  assert.equal(received.length, 2);
  assert.equal(publisher.health().published, 2);
});

test("projection sink failures are contained and observable", async () => {
  const errors: unknown[] = [];
  const publisher = new AsyncProjectionPublisher(async () => {
    throw new Error("dashboard unavailable");
  }, 10, { onError: (error) => errors.push(error) });

  assert.equal(publisher.publish(fixture()), true);
  await publisher.waitForIdle();
  assert.equal(publisher.health().failures, 1);
  assert.equal(errors.length, 1);
});

test("throwing diagnostics cannot stop projection draining", async () => {
  const publisher = new AsyncProjectionPublisher(async () => {
    throw new Error("sink unavailable");
  }, 10, { onError: () => { throw new Error("diagnostic unavailable"); } });
  const second = { ...fixture(), projectionId: "dashboard:second" };

  publisher.publish(fixture());
  publisher.publish(second);
  await publisher.waitForIdle();
  assert.equal(publisher.health().failures, 2);
  assert.equal(publisher.health().queueDepth, 0);
});