import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import {
  PUMP_FEE_PROGRAM_ID,
  PUMP_SWAP_FEE_CONFIG_ADDRESS,
} from "./transaction-policy.js";

const FEE_CONFIG_DISCRIMINATOR = Buffer.from([143, 52, 146, 187, 219, 123, 76, 155]);
const MAX_FEE_TIERS = 256;

const feesSchema = z.object({
  lpFeeBps: z.number().int().nonnegative().max(9_999),
  protocolFeeBps: z.number().int().nonnegative().max(9_999),
  creatorFeeBps: z.number().int().nonnegative().max(9_999),
}).superRefine((fees, context) => {
  if (fees.lpFeeBps + fees.protocolFeeBps + fees.creatorFeeBps >= 10_000) {
    context.addIssue({ code: "custom", message: "PumpSwap total fee must be below 10000 basis points." });
  }
});

const feeTierSchema = z.object({
  marketCapLamportsThreshold: z.string().regex(/^\d+$/),
  fees: feesSchema,
});

export const pumpswapFeeConfigSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  decoderVersion: z.literal("pumpswap-fees-v1"),
  eventId: z.string().min(1),
  source: z.string().min(1),
  observedAt: z.string().datetime(),
  slot: z.number().int().nonnegative().safe(),
  feeConfigAddress: z.literal(PUMP_SWAP_FEE_CONFIG_ADDRESS),
  feeProgramAddress: z.literal(PUMP_FEE_PROGRAM_ID),
  bump: z.number().int().nonnegative().max(255),
  admin: z.string().min(1),
  flatFees: feesSchema,
  feeTiers: z.array(feeTierSchema).max(MAX_FEE_TIERS),
  stableFeeTiers: z.array(feeTierSchema).max(MAX_FEE_TIERS),
});

export type PumpswapFeeConfigSnapshot = z.infer<typeof pumpswapFeeConfigSnapshotSchema>;

interface RpcAccountInfo {
  data: Buffer;
  executable: boolean;
  owner: PublicKey;
}

class FeeConfigReader {
  private offset = FEE_CONFIG_DISCRIMINATOR.length;

  public constructor(private readonly data: Buffer) {}

  private take(length: number, field: string): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.data.length) {
      throw new Error(`PumpSwap fee config is truncated at ${field}.`);
    }
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  public readU8(field: string): number {
    return this.take(1, field).readUInt8(0);
  }

  public readPublicKey(field: string): string {
    return new PublicKey(this.take(32, field)).toBase58();
  }

  public readU64(field: string): bigint {
    return this.take(8, field).readBigUInt64LE(0);
  }

  private readU128(field: string): bigint {
    const value = this.take(16, field);
    return value.readBigUInt64LE(0) + (value.readBigUInt64LE(8) << 64n);
  }

  private decodeFees(field: string): z.input<typeof feesSchema> {
    const values = [
      this.readU64(`${field}.lpFeeBps`),
      this.readU64(`${field}.protocolFeeBps`),
      this.readU64(`${field}.creatorFeeBps`),
    ];
    if (values.some((value) => value > BigInt(Number.MAX_SAFE_INTEGER))) {
      throw new Error(`PumpSwap ${field} exceeds safe integer range.`);
    }
    return {
      lpFeeBps: Number(values[0]),
      protocolFeeBps: Number(values[1]),
      creatorFeeBps: Number(values[2]),
    };
  }

  public readFees(field: string): z.input<typeof feesSchema> {
    return this.decodeFees(field);
  }

  public readFeeTiers(field: string): z.input<typeof feeTierSchema>[] {
    const length = this.take(4, `${field}.length`).readUInt32LE(0);
    if (length > MAX_FEE_TIERS) {
      throw new Error(`PumpSwap ${field} contains too many tiers.`);
    }
    return Array.from({ length }, (_, index) => ({
      marketCapLamportsThreshold: this.readU128(`${field}[${index}].threshold`).toString(),
      fees: this.readFees(`${field}[${index}].fees`),
    }));
  }

  public assertOnlyZeroPadding(): void {
    if (this.data.subarray(this.offset).some((byte) => byte !== 0)) {
      throw new Error("PumpSwap fee config contains unsupported trailing data.");
    }
  }
}

export function decodePumpswapFeeConfigSnapshot(
  input: unknown,
  slot: number,
  source: string,
  observedAt: string,
): PumpswapFeeConfigSnapshot {
  if (typeof input !== "object" || input === null
    || !("data" in input) || !Buffer.isBuffer(input.data)
    || !("owner" in input) || !(input.owner instanceof PublicKey)
    || !("executable" in input) || input.executable !== false) {
    throw new Error("PumpSwap fee config RPC account is malformed.");
  }
  const account = input as RpcAccountInfo;
  if (account.owner.toBase58() !== PUMP_FEE_PROGRAM_ID) {
    throw new Error("PumpSwap fee config account has an invalid owner.");
  }
  if (!account.data.subarray(0, 8).equals(FEE_CONFIG_DISCRIMINATOR)) {
    throw new Error("PumpSwap fee config account has an invalid discriminator.");
  }
  const reader = new FeeConfigReader(account.data);
  const bump = reader.readU8("bump");
  const admin = reader.readPublicKey("admin");
  const flatFees = reader.readFees("flatFees");
  const feeTiers = reader.readFeeTiers("feeTiers");
  const stableFeeTiers = reader.readFeeTiers("stableFeeTiers");
  reader.assertOnlyZeroPadding();
  return pumpswapFeeConfigSnapshotSchema.parse({
    schemaVersion: 1,
    decoderVersion: "pumpswap-fees-v1",
    eventId: `rpc-point-read:${source}:${slot}:${PUMP_SWAP_FEE_CONFIG_ADDRESS}`,
    source,
    observedAt,
    slot,
    feeConfigAddress: PUMP_SWAP_FEE_CONFIG_ADDRESS,
    feeProgramAddress: PUMP_FEE_PROGRAM_ID,
    bump,
    admin,
    flatFees,
    feeTiers,
    stableFeeTiers,
  });
}

export function decodePumpswapFeeConfigSnapshotFromAccounts(
  requestedAddresses: readonly string[],
  returnedAccounts: unknown,
  slot: number,
  source: string,
  observedAt: string,
): PumpswapFeeConfigSnapshot {
  if (!Array.isArray(returnedAccounts) || returnedAccounts.length !== requestedAddresses.length) {
    throw new Error("PumpSwap fee account returns do not match the requested address count.");
  }
  const matchingIndexes = requestedAddresses
    .map((address, index) => address === PUMP_SWAP_FEE_CONFIG_ADDRESS ? index : -1)
    .filter((index) => index >= 0);
  if (matchingIndexes.length !== 1) {
    throw new Error("PumpSwap fee request must contain exactly one verified fee config address.");
  }
  const account = returnedAccounts[matchingIndexes[0]!];
  if (account === null) {
    throw new Error("PumpSwap fee read omitted the verified fee config account.");
  }
  return decodePumpswapFeeConfigSnapshot(account, slot, source, observedAt);
}