import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { parseConfig } from "./config.js";
import { loadWallet } from "./wallet.js";

test("inline private key takes precedence over the configured keypair path", async (context) => {
  const fileWallet = Keypair.generate();
  const inlineWallet = Keypair.generate();
  const path = join(tmpdir(), `snipa-wallet-${process.pid}-${Date.now()}.json`);
  context.after(() => rm(path, { force: true }));
  await writeFile(path, JSON.stringify([...fileWallet.secretKey]));

  const loaded = await loadWallet(parseConfig({
    SOLANA_KEYPAIR_PATH: path,
    SOLANA_PRIVATE_KEY: bs58.encode(inlineWallet.secretKey),
  }));

  assert.equal(loaded.publicKey.toBase58(), inlineWallet.publicKey.toBase58());
  assert.notEqual(loaded.publicKey.toBase58(), fileWallet.publicKey.toBase58());
});

test("blank private key falls back to the configured keypair path", async (context) => {
  const fileWallet = Keypair.generate();
  const path = join(tmpdir(), `snipa-wallet-fallback-${process.pid}-${Date.now()}.json`);
  context.after(() => rm(path, { force: true }));
  await writeFile(path, JSON.stringify([...fileWallet.secretKey]));

  const loaded = await loadWallet(parseConfig({
    SOLANA_KEYPAIR_PATH: path,
    SOLANA_PRIVATE_KEY: "",
  }));

  assert.equal(loaded.publicKey.toBase58(), fileWallet.publicKey.toBase58());
});
