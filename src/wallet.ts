import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { Config } from "./config.js";

function expandHome(path: string): string {
  return path.startsWith("~/") || path.startsWith("~\\")
    ? resolve(homedir(), path.slice(2))
    : resolve(path);
}

function decodeSecret(value: string): Uint8Array {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const bytes = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(bytes) || !bytes.every(Number.isInteger)) {
      throw new Error("The keypair JSON must be an array of byte values.");
    }
    return Uint8Array.from(bytes);
  }
  return bs58.decode(trimmed);
}

export async function loadWallet(config: Config): Promise<Keypair> {
  let secret: string | undefined = config.SOLANA_PRIVATE_KEY;
  if (!secret && config.SOLANA_KEYPAIR_PATH) {
    secret = await readFile(expandHome(config.SOLANA_KEYPAIR_PATH), "utf8");
  }
  if (!secret) {
    throw new Error("Set SOLANA_KEYPAIR_PATH (recommended) or SOLANA_PRIVATE_KEY.");
  }

  const bytes = decodeSecret(secret);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`Expected a 32- or 64-byte Solana secret, received ${bytes.length}.`);
}