import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "./config.js";

test("blank optional PumpPortal API key is treated as absent", () => {
  assert.equal(parseConfig({ PUMPPORTAL_API_KEY: "" }).PUMPPORTAL_API_KEY, undefined);
});

test("submission confirmation alert threshold is optional and strictly positive", () => {
  assert.equal(parseConfig({}).SUBMISSION_CONFIRMATION_ALERT_MS, undefined);
  assert.equal(parseConfig({ SUBMISSION_CONFIRMATION_ALERT_MS: "" })
    .SUBMISSION_CONFIRMATION_ALERT_MS, undefined);
  assert.equal(parseConfig({ SUBMISSION_CONFIRMATION_ALERT_MS: "750" })
    .SUBMISSION_CONFIRMATION_ALERT_MS, 750);
  assert.throws(
    () => parseConfig({ SUBMISSION_CONFIRMATION_ALERT_MS: "0" }),
    /Invalid configuration/,
  );
  assert.throws(
    () => parseConfig({ SUBMISSION_CONFIRMATION_ALERT_MS: "not-a-number" }),
    /Invalid configuration/,
  );
});

test("compute headroom basis points are optional and bounded", () => {
  assert.equal(parseConfig({}).MIN_COMPUTE_HEADROOM_BPS, undefined);
  assert.equal(parseConfig({ MIN_COMPUTE_HEADROOM_BPS: "1000" }).MIN_COMPUTE_HEADROOM_BPS, 1_000);
  assert.throws(() => parseConfig({ MIN_COMPUTE_HEADROOM_BPS: "0" }), /Invalid configuration/);
  assert.throws(() => parseConfig({ MIN_COMPUTE_HEADROOM_BPS: "10000" }), /Invalid configuration/);
});

