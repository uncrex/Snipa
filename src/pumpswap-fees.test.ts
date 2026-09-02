import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  decodePumpswapFeeConfigSnapshot,
  decodePumpswapFeeConfigSnapshotFromAccounts,
} from "./pumpswap-fees.js";
import { PUMP_FEE_PROGRAM_ID, PUMP_SWAP_FEE_CONFIG_ADDRESS } from "./transaction-policy.js";

const discriminator = Buffer.from([143, 52, 146, 187, 219, 123, 76, 155]);

function u64(value: bigint): Buffer {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(value);
  return data;
}

function u128(value: bigint): Buffer {
  return Buffer.concat([u64(value & ((1n << 64n) - 1n)), u64(value >> 64n)]);
}

function fees(lp: bigint, protocol: bigint, creator: bigint): Buffer {
  return Buffer.concat([u64(lp), u64(protocol), u64(creator)]);
}

function tiers(values: Array<[bigint, bigint, bigint, bigint]>): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(values.length);
  return Buffer.concat([
    length,
    ...values.map(([threshold, lp, protocol, creator]) =>
      Buffer.concat([u128(threshold), fees(lp, protocol, creator)])),
  ]);
}

function feeConfigAccount(data: Buffer) {
  return {
    data,
    executable: false,
    owner: new PublicKey(PUMP_FEE_PROGRAM_ID),
  };
}

function validData(): Buffer {
  return Buffer.concat([
    discriminator,
    Buffer.from([254]),
    PublicKey.default.toBuffer(),
    fees(20n, 5n, 5n),
    tiers([[1_000_000n, 15n, 5n, 5n]]),
    tiers([[2_000_000n, 10n, 5n, 0n]]),
  ]);
}

test("PumpSwap fee config decoding preserves flat and tiered schedules", () => {
  const snapshot = decodePumpswapFeeConfigSnapshot(
    feeConfigAccount(validData()),
    123,
    "execution-rpc",
    "2026-08-31T12:00:00.000Z",
  );
  assert.equal(snapshot.decoderVersion, "pumpswap-fees-v1");
  assert.equal(snapshot.slot, 123);
  assert.equal(snapshot.bump, 254);
  assert.deepEqual(snapshot.flatFees, { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 5 });
  assert.deepEqual(snapshot.feeTiers[0], {
    marketCapLamportsThreshold: "1000000",
    fees: { lpFeeBps: 15, protocolFeeBps: 5, creatorFeeBps: 5 },
  });
  assert.equal(snapshot.stableFeeTiers[0]?.marketCapLamportsThreshold, "2000000");
});

test("PumpSwap fee config decoding rejects untrusted account state", () => {
  assert.throws(
    () => decodePumpswapFeeConfigSnapshot(
      { ...feeConfigAccount(validData()), owner: PublicKey.default },
      1,
      "rpc",
      "2026-08-31T12:00:00.000Z",
    ),
    /invalid owner/,
  );
  const badDiscriminator = validData();
  badDiscriminator[0] = badDiscriminator[0]! ^ 255;
  assert.throws(
    () => decodePumpswapFeeConfigSnapshot(
      feeConfigAccount(badDiscriminator), 1, "rpc", "2026-08-31T12:00:00.000Z",
    ),
    /invalid discriminator/,
  );
  assert.throws(
    () => decodePumpswapFeeConfigSnapshot(
      feeConfigAccount(validData().subarray(0, -1)), 1, "rpc", "2026-08-31T12:00:00.000Z",
    ),
    /truncated/,
  );
});

test("PumpSwap fee config decoding rejects invalid fees and trailing state", () => {
  const excessiveFees = validData();
  u64(9_990n).copy(excessiveFees, 41);
  assert.throws(
    () => decodePumpswapFeeConfigSnapshot(
      feeConfigAccount(excessiveFees), 1, "rpc", "2026-08-31T12:00:00.000Z",
    ),
    /total fee must be below 10000/,
  );
  assert.throws(
    () => decodePumpswapFeeConfigSnapshot(
      feeConfigAccount(Buffer.concat([validData(), Buffer.from([1])])),
      1,
      "rpc",
      "2026-08-31T12:00:00.000Z",
    ),
    /unsupported trailing data/,
  );
});

test("PumpSwap fee config decoding binds the exact requested account position", () => {
  const account = feeConfigAccount(validData());
  const snapshot = decodePumpswapFeeConfigSnapshotFromAccounts(
    ["other", PUMP_SWAP_FEE_CONFIG_ADDRESS],
    [null, account],
    123,
    "execution-rpc",
    "2026-08-31T12:00:00.000Z",
  );
  assert.equal(snapshot.slot, 123);
  assert.throws(
    () => decodePumpswapFeeConfigSnapshotFromAccounts(
      ["other"], [account], 1, "rpc", "2026-08-31T12:00:00.000Z",
    ),
    /exactly one verified fee config address/,
  );
  assert.throws(
    () => decodePumpswapFeeConfigSnapshotFromAccounts(
      [PUMP_SWAP_FEE_CONFIG_ADDRESS], [null], 1, "rpc", "2026-08-31T12:00:00.000Z",
    ),
    /omitted the verified fee config/,
  );
});