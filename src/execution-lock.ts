import { mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

export function liveBuyLockPath(journalPath: string): string {
  return `${resolve(journalPath)}.live-buy.lock`;
}

export async function withLiveBuyFileLock<T>(
  journalPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = liveBuyLockPath(journalPath);
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Live buy blocked by execution lock ${lockPath}. Verify no other Snipa process is active before removing it.`,
      );
    }
    throw new Error(
      `Live buy blocked because execution lock creation failed: ${error instanceof Error ? error.message : error}`,
    );
  }

  try {
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      journalPath: resolve(journalPath),
    }), { encoding: "utf8", flag: "wx" });
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true });
  }
}