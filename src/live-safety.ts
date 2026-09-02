import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const LIVE_TRADING_ACKNOWLEDGEMENT = "I_ACKNOWLEDGE_LIVE_TRADING_RISK";

type ArmFileReader = (path: string) => Promise<string>;
type ArmFileStatReader = (path: string) => Promise<{ mtimeMs: number }>;

function resolveArmPath(path: string): string {
  return path.startsWith("~/") || path.startsWith("~\\")
    ? resolve(homedir(), path.slice(2))
    : resolve(path);
}

export async function assertLiveTradingArmed(
  liveTrading: boolean,
  armPath: string | undefined,
  reader: ArmFileReader = (path) => readFile(path, "utf8"),
): Promise<void> {
  if (!liveTrading) return;
  if (!armPath) {
    throw new Error("Live trading is disarmed: set LIVE_TRADING_ARM_PATH.");
  }

  let acknowledgement: string;
  try {
    acknowledgement = await reader(resolveArmPath(armPath));
  } catch (error) {
    throw new Error(
      `Live trading is disarmed: cannot read arm file (${error instanceof Error ? error.message : error}).`,
    );
  }
  if (acknowledgement.trim() !== LIVE_TRADING_ACKNOWLEDGEMENT) {
    throw new Error("Live trading is disarmed: arm file acknowledgement is invalid.");
  }
}

export async function assertRecentLiveTradingArm(
  liveTrading: boolean,
  armPath: string | undefined,
  maxAgeMs: number,
  nowMs = Date.now(),
  reader: ArmFileReader = (path) => readFile(path, "utf8"),
  statReader: ArmFileStatReader = (path) => stat(path),
): Promise<void> {
  await assertLiveTradingArmed(liveTrading, armPath, reader);
  if (!liveTrading) return;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error("Live trading arm maximum age must be a positive safe integer.");
  }
  let modifiedAtMs: number;
  try {
    modifiedAtMs = (await statReader(resolveArmPath(armPath!))).mtimeMs;
  } catch (error) {
    throw new Error(
      `Live trading is disarmed: cannot inspect arm file (${error instanceof Error ? error.message : error}).`,
    );
  }
  const ageMs = nowMs - modifiedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < -5_000 || ageMs > maxAgeMs) {
    throw new Error(`Live trading is disarmed: arm file is not recent (age ${ageMs}ms).`);
  }
}