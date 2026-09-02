import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { liveBuyLockPath, withLiveBuyFileLock } from "./execution-lock.js";

test("live buy file lock excludes overlap and releases after failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snipa-lock-"));
  const journalPath = join(directory, "trades.jsonl");
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => undefined;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    const first = withLiveBuyFileLock(journalPath, async () => {
      started();
      await blocked;
      throw new Error("expected operation failure");
    });
    await didStart;
    const metadata = JSON.parse(await readFile(
      join(liveBuyLockPath(journalPath), "owner.json"),
      "utf8",
    )) as { pid: number; journalPath: string };
    assert.equal(metadata.pid, process.pid);
    assert.equal(metadata.journalPath, journalPath);
    await assert.rejects(
      withLiveBuyFileLock(journalPath, async () => undefined),
      /blocked by execution lock.*Verify no other Snipa process is active/,
    );
    release();
    await assert.rejects(first, /expected operation failure/);
    assert.equal(await withLiveBuyFileLock(journalPath, async () => "reacquired"), "reacquired");
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pre-existing lock residue fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snipa-lock-"));
  const journalPath = join(directory, "trades.jsonl");
  try {
    await mkdir(liveBuyLockPath(journalPath));
    await assert.rejects(
      withLiveBuyFileLock(journalPath, async () => undefined),
      /blocked by execution lock/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});