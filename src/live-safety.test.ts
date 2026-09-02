import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertLiveTradingArmed,
  LIVE_TRADING_ACKNOWLEDGEMENT,
} from "./live-safety.js";

test("paper trading does not require an arm file", async () => {
  await assert.doesNotReject(() => assertLiveTradingArmed(false, undefined));
});

test("live trading fails closed without a readable arm file", async () => {
  await assert.rejects(
    () => assertLiveTradingArmed(true, undefined),
    /set LIVE_TRADING_ARM_PATH/,
  );
  await assert.rejects(
    () => assertLiveTradingArmed(true, "missing.armed", async () => {
      throw new Error("not found");
    }),
    /cannot read arm file/,
  );
});

test("live trading requires the exact acknowledgement", async () => {
  await assert.rejects(
    () => assertLiveTradingArmed(true, "trade.armed", async () => "yes"),
    /acknowledgement is invalid/,
  );
  await assert.doesNotReject(
    () => assertLiveTradingArmed(
      true,
      "trade.armed",
      async () => `${LIVE_TRADING_ACKNOWLEDGEMENT}\n`,
    ),
  );
});