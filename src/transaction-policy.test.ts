import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  assertResolvedTransactionPolicy,
  assertResolvedTransactionPolicyDetails,
  DEFAULT_ALLOWED_PROGRAM_IDS,
  PUMP_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  PUMP_SWAP_PROGRAM_ID,
  PUMP_SWAP_FEE_CONFIG_ADDRESS,
  PUMP_SWAP_GLOBAL_CONFIG_ADDRESS,
  WRAPPED_SOL_MINT,
} from "./transaction-policy.js";

const PUMP_BUY_DISCRIMINATOR = [102, 6, 61, 18, 1, 218, 235, 234];
const PUMP_BUY_EXACT_SOL_IN_DISCRIMINATOR = [56, 252, 116, 8, 158, 223, 205, 95];
const PUMP_SWAP_BUY_EXACT_QUOTE_IN_DISCRIMINATOR = [198, 46, 21, 82, 180, 217, 232, 112];
const PUMP_SELL_DISCRIMINATOR = [51, 230, 133, 164, 1, 127, 131, 173];
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function transactionWithInstructions(
  wallet: Keypair,
  instructions: TransactionInstruction[],
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToLegacyMessage();
  return new VersionedTransaction(message);
}

function tradeInstruction(
  programId: string,
  wallet: Keypair,
  mint: PublicKey,
  action: "buy" | "sell",
  discriminator: ArrayLike<number> = action === "buy" ? PUMP_BUY_DISCRIMINATOR : PUMP_SELL_DISCRIMINATOR,
  additionalSigner?: PublicKey,
  spendLamports = 1_000_000n,
  minOutputLamports = 1n,
): TransactionInstruction {
  const isPumpSwap = programId === PUMP_SWAP_PROGRAM_ID;
  const accountCount = isPumpSwap
    ? (action === "buy" ? 23 : 21)
    : (action === "buy" ? 16 : 14);
  const mintAccountIndex = isPumpSwap ? 3 : 2;
  const userAccountIndex = isPumpSwap ? 1 : 6;
  const writableAccountIndexes = new Set(isPumpSwap
    ? (action === "buy" ? [0, 1, 5, 6, 7, 8, 10, 17, 20] : [0, 1, 5, 6, 7, 8, 10, 17])
    : (action === "buy" ? [1, 3, 4, 5, 6, 9, 13] : [1, 3, 4, 5, 6, 8]));
  const keys = Array.from({ length: accountCount }, (_, index) => ({
    pubkey: Keypair.generate().publicKey,
    isSigner: false,
    isWritable: writableAccountIndexes.has(index),
  }));
  keys[mintAccountIndex] = { pubkey: mint, isSigner: false, isWritable: false };
  keys[userAccountIndex] = { pubkey: wallet.publicKey, isSigner: true, isWritable: true };
  if (isPumpSwap) {
    keys[4] = { pubkey: new PublicKey(WRAPPED_SOL_MINT), isSigner: false, isWritable: false };
    keys[2] = { pubkey: new PublicKey(PUMP_SWAP_GLOBAL_CONFIG_ADDRESS), isSigner: false, isWritable: false };
    const feeConfigIndex = action === "buy" ? 21 : 19;
    keys[feeConfigIndex] = {
      pubkey: new PublicKey(PUMP_SWAP_FEE_CONFIG_ADDRESS), isSigner: false, isWritable: false,
    };
    keys[feeConfigIndex + 1] = {
      pubkey: new PublicKey(PUMP_FEE_PROGRAM_ID), isSigner: false, isWritable: false,
    };
  }
  if (additionalSigner) {
    keys.push({ pubkey: additionalSigner, isSigner: true, isWritable: false });
  }
  const data = Buffer.alloc(action === "buy" ? 25 : 24);
  Buffer.from(discriminator).copy(data);
  if (action === "buy") {
    data.writeBigUInt64LE(1n, 8);
    data.writeBigUInt64LE(spendLamports, 16);
  }
  else {
    data.writeBigUInt64LE(spendLamports, 8);
    data.writeBigUInt64LE(minOutputLamports, 16);
  }
  return new TransactionInstruction({
    keys,
    programId: new PublicKey(programId),
    data,
  });
}

function assertPolicy(
  transaction: VersionedTransaction,
  wallet: Keypair,
  action: "buy" | "sell",
  mint: PublicKey,
  maxSpendLamports = 1_000_000n,
  maxPriorityFeeLamports = 50_000n,
): string[] {
  return assertResolvedTransactionPolicy(
    transaction,
    wallet.publicKey,
    DEFAULT_ALLOWED_PROGRAM_IDS,
    transaction.message.getAccountKeys(),
    action === "buy"
      ? { action, mint, maxSpendLamports, maxPriorityFeeLamports }
      : { action, mint, maxSellAmountRaw: maxSpendLamports, maxPriorityFeeLamports },
  );
}

function associatedTokenInstruction(
  wallet: Keypair,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const [associatedAccount] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.from([1]),
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: associatedAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

test("transaction policy accepts the configured wallet and supported Pump program", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const transaction = transactionWithInstructions(wallet, [
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy"),
  ]);
  assert.deepEqual(assertPolicy(transaction, wallet, "buy", mint), [PUMP_PROGRAM_ID]);
});

test("transaction policy accepts action-compatible PumpSwap trades", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const instruction = tradeInstruction(PUMP_SWAP_PROGRAM_ID, wallet, mint, "sell");
  const transaction = transactionWithInstructions(wallet, [instruction]);
  assert.deepEqual(assertPolicy(transaction, wallet, "sell", mint), [PUMP_SWAP_PROGRAM_ID]);
  const details = assertResolvedTransactionPolicyDetails(
    transaction,
    wallet.publicKey,
    DEFAULT_ALLOWED_PROGRAM_IDS,
    transaction.message.getAccountKeys(),
    { action: "sell", mint, maxSellAmountRaw: 1_000_000n, maxPriorityFeeLamports: 50_000n },
  );
  assert.deepEqual(details.pumpswapTrades, [{
    poolAddress: instruction.keys[0]!.pubkey.toBase58(),
    baseMint: mint.toBase58(),
    quoteMint: WRAPPED_SOL_MINT,
    poolBaseTokenAccount: instruction.keys[7]!.pubkey.toBase58(),
    poolQuoteTokenAccount: instruction.keys[8]!.pubkey.toBase58(),
    globalConfigAddress: PUMP_SWAP_GLOBAL_CONFIG_ADDRESS,
    feeConfigAddress: PUMP_SWAP_FEE_CONFIG_ADDRESS,
    feeProgramAddress: PUMP_FEE_PROGRAM_ID,
    instructionName: "sell",
    inputSemantics: "exact-base-input",
    exactBaseInputRaw: 1_000_000n,
    minQuoteOutputRaw: 1n,
  }]);
});

test("transaction policy exposes exact PumpSwap buy semantics", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const boundedSpend = tradeInstruction(PUMP_SWAP_PROGRAM_ID, wallet, mint, "buy");
  boundedSpend.data.writeBigUInt64LE(500n, 8);
  boundedSpend.data.writeBigUInt64LE(900n, 16);
  const boundedDetails = assertResolvedTransactionPolicyDetails(
    transactionWithInstructions(wallet, [boundedSpend]),
    wallet.publicKey,
    DEFAULT_ALLOWED_PROGRAM_IDS,
    transactionWithInstructions(wallet, [boundedSpend]).message.getAccountKeys(),
    { action: "buy", mint, maxSpendLamports: 900n, maxPriorityFeeLamports: 50_000n },
  );
  assert.deepEqual(boundedDetails.pumpswapTrades[0], {
    poolAddress: boundedSpend.keys[0]!.pubkey.toBase58(),
    baseMint: mint.toBase58(),
    quoteMint: WRAPPED_SOL_MINT,
    poolBaseTokenAccount: boundedSpend.keys[7]!.pubkey.toBase58(),
    poolQuoteTokenAccount: boundedSpend.keys[8]!.pubkey.toBase58(),
    globalConfigAddress: PUMP_SWAP_GLOBAL_CONFIG_ADDRESS,
    feeConfigAddress: PUMP_SWAP_FEE_CONFIG_ADDRESS,
    feeProgramAddress: PUMP_FEE_PROGRAM_ID,
    instructionName: "buy",
    inputSemantics: "maximum-quote-input",
    exactBaseOutputRaw: 500n,
    maxQuoteInputRaw: 900n,
  });

  const exactInput = tradeInstruction(
    PUMP_SWAP_PROGRAM_ID,
    wallet,
    mint,
    "buy",
    PUMP_SWAP_BUY_EXACT_QUOTE_IN_DISCRIMINATOR,
  );
  exactInput.data.writeBigUInt64LE(700n, 8);
  exactInput.data.writeBigUInt64LE(400n, 16);
  const exactInputTransaction = transactionWithInstructions(wallet, [exactInput]);
  const exactInputDetails = assertResolvedTransactionPolicyDetails(
    exactInputTransaction,
    wallet.publicKey,
    DEFAULT_ALLOWED_PROGRAM_IDS,
    exactInputTransaction.message.getAccountKeys(),
    { action: "buy", mint, maxSpendLamports: 700n, maxPriorityFeeLamports: 50_000n },
  );
  assert.equal(exactInputDetails.pumpswapTrades[0]?.instructionName, "buy_exact_quote_in");
  assert.equal(exactInputDetails.pumpswapTrades[0]?.inputSemantics, "exact-quote-input");
  assert.equal(exactInputDetails.pumpswapTrades[0]?.exactQuoteInputRaw, 700n);
  assert.equal(exactInputDetails.pumpswapTrades[0]?.minBaseOutputRaw, 400n);
});

test("transaction policy rejects zero PumpSwap buy output constraints", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const zeroExactOutput = tradeInstruction(PUMP_SWAP_PROGRAM_ID, wallet, mint, "buy");
  zeroExactOutput.data.writeBigUInt64LE(0n, 8);
  assert.throws(
    () => assertPolicy(transactionWithInstructions(wallet, [zeroExactOutput]), wallet, "buy", mint),
    /zero exact base output/,
  );

  const zeroMinimumOutput = tradeInstruction(
    PUMP_SWAP_PROGRAM_ID,
    wallet,
    mint,
    "buy",
    PUMP_SWAP_BUY_EXACT_QUOTE_IN_DISCRIMINATOR,
  );
  zeroMinimumOutput.data.writeBigUInt64LE(1_000_000n, 8);
  zeroMinimumOutput.data.writeBigUInt64LE(0n, 16);
  assert.throws(
    () => assertPolicy(transactionWithInstructions(wallet, [zeroMinimumOutput]), wallet, "buy", mint),
    /zero minimum base output/,
  );
});

test("transaction policy rejects aliased PumpSwap pool identities", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const instruction = tradeInstruction(PUMP_SWAP_PROGRAM_ID, wallet, mint, "buy");
  instruction.keys[8]!.pubkey = instruction.keys[7]!.pubkey;
  const transaction = transactionWithInstructions(wallet, [instruction]);
  assert.throws(
    () => assertPolicy(transaction, wallet, "buy", mint),
    /aliased pool, mint, or vault accounts/,
  );
});

test("transaction policy rejects sell overspend and zero minimum output", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const overspend = transactionWithInstructions(wallet, [
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "sell", PUMP_SELL_DISCRIMINATOR, undefined, 1_000_001n),
  ]);
  assert.throws(
    () => assertPolicy(overspend, wallet, "sell", mint, 1_000_000n),
    /selling 1000001 raw token units; requested maximum is 1000000/,
  );

  const zeroMinimum = transactionWithInstructions(wallet, [
    tradeInstruction(PUMP_SWAP_PROGRAM_ID, wallet, mint, "sell", PUMP_SELL_DISCRIMINATOR, undefined, 1_000_000n, 0n),
  ]);
  assert.throws(
    () => assertPolicy(zeroMinimum, wallet, "sell", mint),
    /zero minimum output/,
  );
});

test("transaction policy rejects additional required signers", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const additionalSigner = Keypair.generate();
  const transaction = transactionWithInstructions(wallet, [
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy", PUMP_BUY_DISCRIMINATOR, additionalSigner.publicKey),
  ]);
  assert.throws(
    () => assertPolicy(transaction, wallet, "buy", mint),
    /expected exactly one/,
  );
});

test("transaction policy rejects action-mismatched and unknown Pump instructions", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const mismatched = transactionWithInstructions(wallet, [
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy"),
  ]);
  assert.throws(() => assertPolicy(mismatched, wallet, "sell", mint), /buy instruction.*sell action/);

  const unknown = transactionWithInstructions(wallet, [
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy", Buffer.alloc(8, 255)),
  ]);
  assert.throws(() => assertPolicy(unknown, wallet, "buy", mint), /unknown.*instruction discriminator/);
});

test("transaction policy rejects truncated PumpSwap account layouts", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const instruction = tradeInstruction(PUMP_SWAP_PROGRAM_ID, wallet, mint, "buy");
  instruction.keys.splice(4);
  const transaction = transactionWithInstructions(wallet, [instruction]);
  assert.throws(
    () => assertPolicy(transaction, wallet, "buy", mint),
    /with 4 accounts; expected at least 23/,
  );
});

test("transaction policy rejects missing and unexpected writable privileges", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const missingWritable = tradeInstruction(PUMP_SWAP_PROGRAM_ID, wallet, mint, "sell");
  missingWritable.keys[0]!.isWritable = false;
  const missingWritableTransaction = transactionWithInstructions(wallet, [missingWritable]);
  assert.throws(
    () => assertPolicy(missingWritableTransaction, wallet, "sell", mint),
    /unexpected writable privilege at account 0/,
  );

  const unexpectedWritable = tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy");
  unexpectedWritable.keys[2]!.isWritable = true;
  const unexpectedWritableTransaction = transactionWithInstructions(wallet, [unexpectedWritable]);
  assert.throws(
    () => assertPolicy(unexpectedWritableTransaction, wallet, "buy", mint),
    /unexpected writable privilege at account 2/,
  );
});

test("transaction policy decodes exact-input buys and rejects aggregate overspend", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const exactInput = tradeInstruction(
    PUMP_PROGRAM_ID,
    wallet,
    mint,
    "buy",
    PUMP_BUY_EXACT_SOL_IN_DISCRIMINATOR,
  );
  exactInput.data.writeBigUInt64LE(750_000n, 8);
  const exactInputTransaction = transactionWithInstructions(wallet, [exactInput]);
  assert.throws(
    () => assertPolicy(exactInputTransaction, wallet, "buy", mint, 749_999n),
    /spending up to 750000 lamports/,
  );

  const aggregateTransaction = transactionWithInstructions(wallet, [
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy", PUMP_BUY_DISCRIMINATOR, undefined, 600_000n),
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy", PUMP_BUY_DISCRIMINATOR, undefined, 600_000n),
  ]);
  assert.throws(
    () => assertPolicy(aggregateTransaction, wallet, "buy", mint, 1_000_000n),
    /spending up to 1200000 lamports/,
  );
});

test("transaction policy rejects non-SOL quote mints and malformed trade data", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const wrongQuote = tradeInstruction(PUMP_SWAP_PROGRAM_ID, wallet, mint, "buy");
  wrongQuote.keys[4]!.pubkey = Keypair.generate().publicKey;
  const wrongQuoteTransaction = transactionWithInstructions(wallet, [wrongQuote]);
  assert.throws(
    () => assertPolicy(wrongQuoteTransaction, wallet, "buy", mint),
    /quote mint is not wrapped SOL/,
  );

  const malformed = tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy");
  malformed.data = malformed.data.subarray(0, 24);
  const malformedTransaction = transactionWithInstructions(wallet, [malformed]);
  assert.throws(
    () => assertPolicy(malformedTransaction, wallet, "buy", mint),
    /with 24 data bytes; expected 25/,
  );
});

test("transaction policy accepts bounded compute settings and wallet-owned ATA creation", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const transaction = transactionWithInstructions(wallet, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 }),
    associatedTokenInstruction(wallet, wallet.publicKey, mint),
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy"),
  ]);
  assert.deepEqual(assertPolicy(transaction, wallet, "buy", mint), [
    ComputeBudgetProgram.programId.toBase58(),
    ComputeBudgetProgram.programId.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    PUMP_PROGRAM_ID,
  ]);
  const details = assertResolvedTransactionPolicyDetails(
    transaction,
    wallet.publicKey,
    DEFAULT_ALLOWED_PROGRAM_IDS,
    transaction.message.getAccountKeys(),
    {
      action: "buy",
      mint,
      maxSpendLamports: 1_000_000n,
      maxPriorityFeeLamports: 50_000n,
    },
  );
  assert.equal(details.computeUnitLimit, 200_000);
  assert.equal(details.computeUnitPriceMicroLamports, 250_000n);
  assert.equal(details.maxPriorityFeeLamports, 50_000n);
});

test("transaction policy rejects priority-fee escalation and duplicate compute settings", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const excessiveFee = transactionWithInstructions(wallet, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_001 }),
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy"),
  ]);
  assert.throws(
    () => assertPolicy(excessiveFee, wallet, "buy", mint),
    /priority fee up to 50001 lamports/,
  );

  const duplicateLimit = transactionWithInstructions(wallet, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy"),
  ]);
  assert.throws(
    () => assertPolicy(duplicateLimit, wallet, "buy", mint),
    /duplicate compute unit limit/,
  );
});

test("transaction policy rejects unsafe top-level System and SPL Token instructions", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const systemTransfer = transactionWithInstructions(wallet, [
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy"),
  ]);
  assert.throws(
    () => assertPolicy(systemTransfer, wallet, "buy", mint),
    /top-level System Program instruction/,
  );

  const tokenInstruction = transactionWithInstructions(wallet, [
    new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [], data: Buffer.from([17]) }),
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy"),
  ]);
  assert.throws(
    () => assertPolicy(tokenInstruction, wallet, "buy", mint),
    /top-level SPL Token instruction/,
  );
});

test("transaction policy rejects ATA creation for another owner", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const transaction = transactionWithInstructions(wallet, [
    associatedTokenInstruction(wallet, Keypair.generate().publicKey, mint),
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy"),
  ]);
  assert.throws(
    () => assertPolicy(transaction, wallet, "buy", mint),
    /owner other than the configured wallet/,
  );
});

test("transaction policy rejects a trade for a different mint", () => {
  const wallet = Keypair.generate();
  const requestedMint = Keypair.generate().publicKey;
  const transactionMint = Keypair.generate().publicKey;
  const transaction = transactionWithInstructions(wallet, [
    tradeInstruction(PUMP_PROGRAM_ID, wallet, transactionMint, "sell"),
  ]);
  assert.throws(
    () => assertPolicy(transaction, wallet, "sell", requestedMint),
    /mint does not match/,
  );
});

test("transaction policy rejects unknown and non-trading programs", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const unknownProgram = Keypair.generate().publicKey;
  const unknownTransaction = transactionWithInstructions(wallet, [
    new TransactionInstruction({ programId: unknownProgram, keys: [], data: Buffer.alloc(0) }),
  ]);
  assert.throws(
    () => assertPolicy(unknownTransaction, wallet, "buy", mint),
    /unallowlisted/,
  );

  const systemOnlyTransaction = transactionWithInstructions(wallet, [
    new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.alloc(0) }),
  ]);
  assert.throws(
    () => assertPolicy(systemOnlyTransaction, wallet, "buy", mint),
    /does not invoke.*supported Pump/,
  );

  const configuredProgram = Keypair.generate().publicKey;
  const configuredTransaction = transactionWithInstructions(wallet, [
    new TransactionInstruction({ programId: configuredProgram, keys: [], data: Buffer.alloc(0) }),
    tradeInstruction(PUMP_PROGRAM_ID, wallet, mint, "buy"),
  ]);
  assert.throws(
    () => assertResolvedTransactionPolicy(
      configuredTransaction,
      wallet.publicKey,
      [...DEFAULT_ALLOWED_PROGRAM_IDS, configuredProgram.toBase58()],
      configuredTransaction.message.getAccountKeys(),
      { action: "buy", mint, maxSpendLamports: 1_000_000n, maxPriorityFeeLamports: 50_000n },
    ),
    /has no instruction policy/,
  );
});

test("transaction policy rejects substituted PumpSwap fee configuration accounts", () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  for (const [index, message] of [
    [2, /invalid global config account/],
    [21, /invalid fee config account/],
    [22, /invalid fee program account/],
  ] as const) {
    const instruction = tradeInstruction(PUMP_SWAP_PROGRAM_ID, wallet, mint, "buy");
    instruction.keys[index]!.pubkey = Keypair.generate().publicKey;
    assert.throws(
      () => assertPolicy(transactionWithInstructions(wallet, [instruction]), wallet, "buy", mint),
      message,
    );
  }
});