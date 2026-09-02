import assert from "node:assert/strict";
import { test } from "node:test";
import { autoBuyRejectionReasons, canAutoBuy, reconnectDelay } from "./monitor.js";
import { requiredBuyBalance } from "./trader.js";

test("reconnectDelay grows exponentially and caps at 30 seconds", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 20].map(reconnectDelay),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
  );
});

test("canAutoBuy enforces both order count and cumulative spend", () => {
  const boughtMints = new Set<string>();
  assert.equal(canAutoBuy(0, 0, 0.01, 2, 0.02, "MintA", boughtMints), true);
  assert.equal(canAutoBuy(1, 0.1, 0.2, 2, 0.3, "MintA", boughtMints), true);
  assert.equal(canAutoBuy(2, 0, 0.01, 2, 0.02, "MintA", boughtMints), false);
  assert.equal(canAutoBuy(1, 0.02, 0.01, 2, 0.02, "MintA", boughtMints), false);
});

test("canAutoBuy rejects a mint only after it has been recorded", () => {
  const boughtMints = new Set<string>();
  assert.equal(canAutoBuy(0, 0, 0.01, 2, 0.02, "MintA", boughtMints), true);
  assert.equal(canAutoBuy(0, 0, 0.01, 2, 0.02, "MintA", boughtMints), true);

  boughtMints.add("MintA");
  assert.equal(canAutoBuy(1, 0.01, 0.01, 2, 0.02, "MintA", boughtMints), false);
  assert.equal(canAutoBuy(1, 0.01, 0.01, 2, 0.02, "MintB", boughtMints), true);
});

test("autoBuyRejectionReasons reports every failed session rule", () => {
  assert.deepEqual(
    autoBuyRejectionReasons(2, 0.02, 0.01, 2, 0.02, "MintA", new Set(["MintA"])),
    [
      "Session buy count 2 reached limit 2.",
      "Reserved session spend 0.03 SOL exceeds limit 0.02 SOL.",
      "Token was already bought in this monitor session.",
    ],
  );
});

test("requiredBuyBalance includes amount, priority fee, and reserve", () => {
  assert.equal(requiredBuyBalance(0.01, 0.00005, 0.02), 0.03005);
});