import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { PUMP_PROGRAM_ID } from "./transaction-policy.js";

const BONDING_CURVE_DISCRIMINATOR = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
const GLOBAL_DISCRIMINATOR = Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]);
const pumpProgram = new PublicKey(PUMP_PROGRAM_ID);

export interface PumpBondingProgress {
  progressBps: number;
  complete: boolean;
  currentMarketCapSol: number;
  currentMarketCapUsd?: number;
}

interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

interface GlobalState {
  initialVirtualTokenReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
}

function verifiedData(
  account: AccountInfo<Buffer> | null,
  discriminator: Buffer,
  minimumLength: number,
  name: string,
): Buffer {
  if (!account
    || account.executable
    || !account.owner.equals(pumpProgram)
    || account.data.length < minimumLength
    || !account.data.subarray(0, 8).equals(discriminator)) {
    throw new Error(`Pump ${name} account failed ownership, layout, or discriminator verification.`);
  }
  return account.data;
}

function decodeBondingCurve(account: AccountInfo<Buffer> | null): BondingCurveState {
  const data = verifiedData(account, BONDING_CURVE_DISCRIMINATOR, 49, "bonding curve");
  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: data.readUInt8(48) === 1,
  };
}

function decodeGlobal(account: AccountInfo<Buffer> | null): GlobalState {
  const data = verifiedData(account, GLOBAL_DISCRIMINATOR, 105, "global");
  return {
    initialVirtualTokenReserves: data.readBigUInt64LE(73),
    initialRealTokenReserves: data.readBigUInt64LE(89),
    tokenTotalSupply: data.readBigUInt64LE(97),
  };
}

export function calculatePumpBondingProgress(
  bondingCurveAccount: AccountInfo<Buffer> | null,
  globalAccount: AccountInfo<Buffer> | null,
): PumpBondingProgress {
  const curve = decodeBondingCurve(bondingCurveAccount);
  if (curve.virtualTokenReserves === 0n || curve.virtualSolReserves === 0n) {
    throw new Error("Pump bonding curve has invalid virtual reserves.");
  }
  const marketCapScale = 1_000_000n;
  const marketCapDenominator = curve.virtualTokenReserves * 1_000_000_000n;
  const scaledMarketCap = (
    curve.virtualSolReserves * curve.tokenTotalSupply * marketCapScale
    + marketCapDenominator / 2n
  ) / marketCapDenominator;
  if (scaledMarketCap > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Pump bonding curve market cap exceeds the supported range.");
  }
  const currentMarketCapSol = Number(scaledMarketCap) / Number(marketCapScale);
  if (curve.complete) {
    if (curve.realTokenReserves !== 0n) {
      throw new Error("Completed Pump bonding curve has nonzero real token reserves.");
    }
    return { progressBps: 10_000, complete: true, currentMarketCapSol };
  }

  const global = decodeGlobal(globalAccount);
  if (global.initialRealTokenReserves === 0n
    || curve.realTokenReserves > global.initialRealTokenReserves
    || curve.tokenTotalSupply !== global.tokenTotalSupply
    || curve.virtualTokenReserves < curve.realTokenReserves
    || global.initialVirtualTokenReserves < global.initialRealTokenReserves
    || curve.virtualTokenReserves - curve.realTokenReserves
      !== global.initialVirtualTokenReserves - global.initialRealTokenReserves) {
    throw new Error("Pump bonding curve does not match the verified Global reserve parameters.");
  }
  const soldTokens = global.initialRealTokenReserves - curve.realTokenReserves;
  return {
    progressBps: Number(soldTokens * 10_000n / global.initialRealTokenReserves),
    complete: false,
    currentMarketCapSol,
  };
}

export async function readPumpBondingProgress(
  connection: Connection,
  mintAddress: string,
): Promise<PumpBondingProgress> {
  const mint = new PublicKey(mintAddress);
  const [bondingCurveAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    pumpProgram,
  );
  const [globalAddress] = PublicKey.findProgramAddressSync([Buffer.from("global")], pumpProgram);
  const accounts = await connection.getMultipleAccountsInfo(
    [bondingCurveAddress, globalAddress],
    "confirmed",
  );
  const progress = calculatePumpBondingProgress(accounts[0] ?? null, accounts[1] ?? null);
  try {
    const response = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return progress;
    const input = await response.json() as { data?: { amount?: unknown } };
    const solUsdPrice = typeof input.data?.amount === "string"
      ? Number(input.data.amount)
      : Number.NaN;
    if (!Number.isFinite(solUsdPrice) || solUsdPrice <= 0) return progress;
    return {
      ...progress,
      currentMarketCapUsd: progress.currentMarketCapSol * solUsdPrice,
    };
  } catch {
    return progress;
  }
}