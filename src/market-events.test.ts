import assert from "node:assert/strict";
import { test } from "node:test";
import bs58 from "bs58";
import {
  decodePumpPortalLaunchEvent,
  EventDeduplicator,
  StreamContinuityGuard,
} from "./market-events.js";

const mint = "So11111111111111111111111111111111111111112";
const actor = "11111111111111111111111111111111";
const signature = bs58.encode(Buffer.alloc(64, 1));

test("PumpPortal launch fixtures decode into deterministic versioned events", () => {
  const observedAt = "2026-08-31T12:00:00.000Z";
  const fixture = {
    signature,
    mint,
    name: "Fixture Token",
    symbol: "FIX",
    traderPublicKey: actor,
    txType: "create",
    marketCapSol: 31.5,
  };

  const first = decodePumpPortalLaunchEvent(fixture, observedAt);
  const second = decodePumpPortalLaunchEvent(fixture, observedAt);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    schemaVersion: 1,
    decoderVersion: "pumpportal-launch-v1",
    eventId: `solana:token-created:${signature}`,
    kind: "token-created",
    venue: "pump",
    source: "pumpportal",
    observedAt,
    slot: null,
    writeVersion: null,
    transactionSignature: signature,
    mint,
    name: "Fixture Token",
    symbol: "FIX",
    actor,
  });
});

test("PumpPortal launch decoder rejects malformed and non-create events", () => {
  assert.throws(
    () => decodePumpPortalLaunchEvent(
      { signature, mint, txType: "buy" },
      "2026-08-31T12:00:00.000Z",
    ),
  );
  assert.throws(
    () => decodePumpPortalLaunchEvent(
      { signature, mint: "not-a-public-key", txType: "create" },
      "2026-08-31T12:00:00.000Z",
    ),
  );
  assert.throws(
    () => decodePumpPortalLaunchEvent(
      { signature: "not-a-signature", mint, txType: "create" },
      "2026-08-31T12:00:00.000Z",
    ),
  );
});

test("event deduplication rejects repeats and evicts the oldest identity", () => {
  const deduplicator = new EventDeduplicator(2);
  assert.equal(deduplicator.accept({ eventId: "event-a" }), true);
  assert.equal(deduplicator.accept({ eventId: "event-a" }), false);
  assert.equal(deduplicator.accept({ eventId: "event-b" }), true);
  assert.equal(deduplicator.accept({ eventId: "event-c" }), true);
  assert.equal(deduplicator.accept({ eventId: "event-a" }), true);
});

test("stream continuity fails closed after a connected stream disconnects", () => {
  const continuity = new StreamContinuityGuard();
  assert.equal(continuity.canEnter(), false);
  assert.match(continuity.rejectionReason() ?? "", /has not connected/);

  continuity.connected();
  assert.equal(continuity.canEnter(), true);
  assert.equal(continuity.rejectionReason(), null);

  continuity.disconnected();
  continuity.connected();
  assert.equal(continuity.canEnter(), false);
  assert.match(continuity.rejectionReason() ?? "", /without verified backfill/);
});

test("a failed initial connection does not taint the first successful connection", () => {
  const continuity = new StreamContinuityGuard();
  continuity.disconnected();
  continuity.connected();
  assert.equal(continuity.canEnter(), true);
});