import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { calculatePumpBondingProgress } from "./pump-bonding-progress.js";
import { PUMP_PROGRAM_ID } from "./transaction-policy.js";

const owner = new PublicKey(PUMP_PROGRAM_ID);

function account(data: Buffer): AccountInfo<Buffer> {
  return { data, executable: false, lamports: 1, owner, rentEpoch: 0 };
}

function curve(overrides: {
  real?: bigint;
  virtual?: bigint;
  virtualSol?: bigint;
  supply?: bigint;
  complete?: boolean;
} = {}) {
  const data = Buffer.alloc(81);
  Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(data);
  data.writeBigUInt64LE(overrides.virtual ?? 676_550n, 8);
  data.writeBigUInt64LE(overrides.virtualSol ?? 67_655_000_000n, 16);
  data.writeBigUInt64LE(overrides.real ?? 396_550n, 24);
  data.writeBigUInt64LE(overrides.supply ?? 1_000_000n, 40);
  data.writeUInt8(overrides.complete ? 1 : 0, 48);
  return account(data);
}

function global() {
  const data = Buffer.alloc(105);
  Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]).copy(data);
  data.writeBigUInt64LE(1_073_100n, 73);
  data.writeBigUInt64LE(793_100n, 89);
  data.writeBigUInt64LE(1_000_000n, 97);
  return account(data);
}

test("bonding progress uses verified matching reserve parameters", () => {
  assert.deepEqual(calculatePumpBondingProgress(curve(), global()), {
    progressBps: 5_000,
    complete: false,
    currentMarketCapSol: 100,
  });
});

test("completed bonding progress requires zero real reserves", () => {
  assert.deepEqual(calculatePumpBondingProgress(curve({ real: 0n, complete: true }), null), {
    progressBps: 10_000,
    complete: true,
    currentMarketCapSol: 100,
  });
  assert.throws(
    () => calculatePumpBondingProgress(curve({ complete: true }), global()),
    /nonzero real token reserves/,
  );
});

test("bonding progress rejects mismatched creation parameters", () => {
  assert.throws(
    () => calculatePumpBondingProgress(curve({ virtual: 676_551n }), global()),
    /does not match/,
  );
  const wrongOwner = curve();
  wrongOwner.owner = PublicKey.default;
  assert.throws(
    () => calculatePumpBondingProgress(wrongOwner, global()),
    /failed ownership/,
  );
  assert.throws(
    () => calculatePumpBondingProgress(curve({ virtualSol: 0n }), global()),
    /invalid virtual reserves/,
  );
});