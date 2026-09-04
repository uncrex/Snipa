import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  assertPhantomTransactionEnvelope,
  buildPhantomBuyTransaction,
} from "./phantom-trade.js";
import { TOKEN_2022_PROGRAM_ID } from "./transaction-policy.js";

function unsignedTransaction(wallet: PublicKey, mint?: PublicKey): VersionedTransaction {
  const instruction = new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: mint ? [{ pubkey: mint, isSigner: false, isWritable: false }] : [],
    data: Buffer.alloc(0),
  });
  return new VersionedTransaction(new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [instruction],
  }).compileToV0Message());
}

const token2022Account = {
  owner: new PublicKey(TOKEN_2022_PROGRAM_ID),
  executable: false,
};

test("Phantom envelope accepts an unsigned Token-2022 transaction for the connected wallet", async () => {
  const wallet = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  await assert.doesNotReject(assertPhantomTransactionEnvelope(
    unsignedTransaction(wallet, mint),
    wallet,
    mint,
    {
      getAddressLookupTable: async () => ({ context: { slot: 1 }, value: null }),
      getAccountInfo: async () => token2022Account as never,
    },
  ));
});

test("Phantom envelope rejects a different fee payer or a missing requested mint", async () => {
  const wallet = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const connection = {
    getAddressLookupTable: async () => ({ context: { slot: 1 }, value: null }),
    getAccountInfo: async () => token2022Account as never,
  };

  await assert.rejects(
    assertPhantomTransactionEnvelope(
      unsignedTransaction(Keypair.generate().publicKey, mint),
      wallet,
      mint,
      connection,
    ),
    /fee payer does not match/,
  );
  await assert.rejects(
    assertPhantomTransactionEnvelope(unsignedTransaction(wallet), wallet, mint, connection),
    /does not reference the requested mint/,
  );
});

test("Phantom builder sends the capped request and returns the validated unsigned bytes", async () => {
  const wallet = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const transaction = unsignedTransaction(wallet, mint);
  let routeBody: Record<string, unknown> | undefined;
  const bytes = await buildPhantomBuyTransaction(
    {
      mint: mint.toBase58(),
      amountSol: 0.005,
      publicKey: wallet.toBase58(),
      slippagePercent: 5,
      priorityFeeSol: 0.00005,
    },
    {
      getAddressLookupTable: async () => ({ context: { slot: 1 }, value: null }),
      getAccountInfo: async () => token2022Account as never,
    },
    async (_url, init) => {
      routeBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(Uint8Array.from(transaction.serialize()).buffer);
    },
  );

  assert.deepEqual(routeBody, {
    publicKey: wallet.toBase58(),
    action: "buy",
    mint: mint.toBase58(),
    amount: 0.005,
    denominatedInSol: "true",
    slippage: 5,
    priorityFee: 0.00005,
    pool: "auto",
  });
  assert.deepEqual(bytes, transaction.serialize());
});
