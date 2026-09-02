import assert from "node:assert/strict";
import { test } from "node:test";
import { type ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { decodeConfirmedPublicBuy } from "./solana-public-buys.js";
import { PUMP_PROGRAM_ID } from "./transaction-policy.js";

const mint = new PublicKey("FYwxAEKhksrMFeUgxwRE99Jn3BcdzK3Y1JPUbkf3pump");
const buyer = new PublicKey("11111111111111111111111111111111");

function fixture(overrides: {
  failed?: boolean;
  tokenIncrease?: boolean;
  discriminator?: number[];
  dataLength?: number;
  signature?: string;
} = {}) {
  const accounts = Array.from({ length: 16 }, () => PublicKey.default);
  accounts[2] = mint;
  accounts[6] = buyer;
  const data = Buffer.alloc(overrides.dataLength ?? 25);
  Buffer.from(overrides.discriminator ?? [102, 6, 61, 18, 1, 218, 235, 234]).copy(data);
  return {
    blockTime: 1_788_181_200,
    meta: {
      err: overrides.failed ? { InstructionError: [0, "Custom"] } : null,
      preBalances: [1_000_000_000],
      postBalances: [897_000_000],
      preTokenBalances: [{
        accountIndex: 1,
        mint: mint.toBase58(),
        owner: buyer.toBase58(),
        uiTokenAmount: { amount: "100", decimals: 6, uiAmount: 0.0001, uiAmountString: "0.0001" },
      }],
      postTokenBalances: [{
        accountIndex: 1,
        mint: mint.toBase58(),
        owner: buyer.toBase58(),
        uiTokenAmount: {
          amount: overrides.tokenIncrease === false ? "100" : "200",
          decimals: 6,
          uiAmount: overrides.tokenIncrease === false ? 0.0001 : 0.0002,
          uiAmountString: overrides.tokenIncrease === false ? "0.0001" : "0.0002",
        },
      }],
      innerInstructions: null,
    },
    transaction: {
      message: {
        accountKeys: [{ pubkey: buyer, signer: true, writable: true }],
        instructions: [{
          accounts,
          data: bs58.encode(data),
          programId: new PublicKey(PUMP_PROGRAM_ID),
          stackHeight: null,
        }],
      },
      signatures: [overrides.signature ?? "signature-a"],
    },
  } as unknown as ParsedTransactionWithMeta;
}

test("confirmed public buy requires a recognized instruction and positive target-token delta", () => {
  assert.deepEqual(decodeConfirmedPublicBuy("signature-a", fixture(), mint.toBase58()), {
    signature: "signature-a",
    mint: mint.toBase58(),
    walletDecreaseSol: 0.103,
    confirmedAt: "2026-08-31T13:00:00.000Z",
  });
  assert.equal(
    decodeConfirmedPublicBuy("signature-a", fixture({ dataLength: 24 }), mint.toBase58())?.walletDecreaseSol,
    0.103,
  );
  assert.equal(decodeConfirmedPublicBuy(
    "signature-a",
    fixture({ tokenIncrease: false }),
    mint.toBase58(),
  ), undefined);
  assert.equal(decodeConfirmedPublicBuy(
    "signature-a",
    fixture({ discriminator: [51, 230, 133, 164, 1, 127, 131, 173] }),
    mint.toBase58(),
  ), undefined);
  assert.equal(decodeConfirmedPublicBuy(
    "signature-a",
    fixture({ failed: true }),
    mint.toBase58(),
  ), undefined);
});

test("public buy polling uses signed transaction identity and leaves qualifying buys retryable", async () => {
  const connection = {
    getSignaturesForAddress: async () => [
      { signature: "signature-a", blockTime: 1_788_181_200, err: null },
      { signature: "signature-b", blockTime: 1_788_181_200, err: null },
    ],
    getParsedTransactions: async () => [
      fixture({ signature: "signature-b" }),
      fixture({ signature: "signature-a" }),
    ],
  } as unknown as import("@solana/web3.js").Connection;
  const observed = new Set<string>();
  const { readConfirmedPublicBuys } = await import("./solana-public-buys.js");
  const buys = await readConfirmedPublicBuys(
    connection,
    mint.toBase58(),
    0.05,
    observed,
    3_600,
    1_788_181_200_000,
  );
  assert.deepEqual(buys.map((buy) => buy.signature), ["signature-b", "signature-a"]);
  assert.deepEqual([...observed], []);
});