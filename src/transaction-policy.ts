import {
  type AddressLookupTableAccount,
  ComputeBudgetInstruction,
  type Connection,
  type MessageAccountKeys,
  PublicKey,
  TransactionInstruction,
  type VersionedTransaction,
} from "@solana/web3.js";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_SWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const PUMP_FEE_PROGRAM_ID = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MAX_COMPUTE_UNITS = 1_400_000;
export const PUMP_SWAP_GLOBAL_CONFIG_ADDRESS = PublicKey.findProgramAddressSync(
  [Buffer.from("global_config")],
  new PublicKey(PUMP_SWAP_PROGRAM_ID),
)[0].toBase58();
export const PUMP_SWAP_FEE_CONFIG_ADDRESS = PublicKey.findProgramAddressSync(
  [Buffer.from("fee_config"), new PublicKey(PUMP_SWAP_PROGRAM_ID).toBuffer()],
  new PublicKey(PUMP_FEE_PROGRAM_ID),
)[0].toBase58();

export const DEFAULT_ALLOWED_PROGRAM_IDS = [
  SYSTEM_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_SWAP_PROGRAM_ID,
] as const;

const supportedTradePrograms = new Set([PUMP_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID]);

interface TransactionTradeContextBase {
  mint: PublicKey;
  maxPriorityFeeLamports: bigint;
}

export type TransactionTradeContext = TransactionTradeContextBase & (
  | { action: "buy"; maxSpendLamports: bigint }
  | { action: "sell"; maxSellAmountRaw: bigint }
);

export interface TransactionPolicyDetails {
  invokedPrograms: string[];
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
  maxPriorityFeeLamports: bigint;
  pumpswapTrades: PumpswapTrade[];
}

export interface PumpswapTradeAccounts {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  poolBaseTokenAccount: string;
  poolQuoteTokenAccount: string;
}

export interface PumpswapFeeAccounts {
  globalConfigAddress: string;
  feeConfigAddress: string;
  feeProgramAddress: string;
}

export type PumpswapTrade = PumpswapTradeAccounts & PumpswapFeeAccounts & (
  | {
    instructionName: "buy";
    inputSemantics: "maximum-quote-input";
    exactBaseOutputRaw: bigint;
    maxQuoteInputRaw: bigint;
  }
  | {
    instructionName: "buy_exact_quote_in";
    inputSemantics: "exact-quote-input";
    exactQuoteInputRaw: bigint;
    minBaseOutputRaw: bigint;
  }
  | {
    instructionName: "sell";
    inputSemantics: "exact-base-input";
    exactBaseInputRaw: bigint;
    minQuoteOutputRaw: bigint;
  }
);

interface TradeInstructionPolicy {
  action: TransactionTradeContext["action"];
  instructionName: string;
  requiredAccountCount: number;
  writableAccountIndexes: readonly number[];
  mintAccountIndex: number;
  userAccountIndex: number;
  instructionDataLength: number;
  maxSpendOffset?: number;
  exactBaseOutputOffset?: number;
  sellAmountOffset?: number;
  minOutputOffset?: number;
  quoteMintAccountIndex?: number;
  feeConfigAccountIndex?: number;
  feeProgramAccountIndex?: number;
}

const instructionKey = (bytes: ArrayLike<number>) => Buffer.from(bytes).toString("hex");

function resolvedInstruction(
  programId: PublicKey,
  instructionData: Uint8Array,
  accountKeyIndexes: readonly number[],
  accountKeys: MessageAccountKeys,
  message: VersionedTransaction["message"],
): TransactionInstruction {
  const keys = accountKeyIndexes.map((accountKeyIndex) => {
    const pubkey = accountKeys.get(accountKeyIndex);
    if (!pubkey) {
      throw new Error(`Rejected instruction with invalid account index ${accountKeyIndex}.`);
    }
    return {
      pubkey,
      isSigner: message.isAccountSigner(accountKeyIndex),
      isWritable: message.isAccountWritable(accountKeyIndex),
    };
  });
  return new TransactionInstruction({ programId, keys, data: Buffer.from(instructionData) });
}

function assertAssociatedTokenInstruction(
  instruction: TransactionInstruction,
  wallet: PublicKey,
  context: TransactionTradeContext,
): void {
  const isCreate = instruction.data.length === 0;
  const isCreateIdempotent = instruction.data.length === 1 && instruction.data[0] === 1;
  if (!isCreate && !isCreateIdempotent) {
    throw new Error("Rejected unsupported Associated Token instruction.");
  }
  if (instruction.keys.length < 6) {
    throw new Error("Rejected Associated Token creation with fewer than 6 accounts.");
  }
  const [payer, associatedAccount, owner, mint, systemProgram, tokenProgram] = instruction.keys;
  if (!payer?.pubkey.equals(wallet) || !payer.isSigner || !payer.isWritable) {
    throw new Error("Rejected Associated Token creation not paid by the configured wallet.");
  }
  if (!owner?.pubkey.equals(wallet)) {
    throw new Error("Rejected Associated Token creation for an owner other than the configured wallet.");
  }
  const allowedMints = new Set([context.mint.toBase58(), WRAPPED_SOL_MINT]);
  if (!mint || !allowedMints.has(mint.pubkey.toBase58())) {
    throw new Error("Rejected Associated Token creation for an unrelated mint.");
  }
  if (systemProgram?.pubkey.toBase58() !== SYSTEM_PROGRAM_ID
    || tokenProgram?.pubkey.toBase58() !== SPL_TOKEN_PROGRAM_ID) {
    throw new Error("Rejected Associated Token creation with unexpected supporting programs.");
  }
  const [expectedAddress] = PublicKey.findProgramAddressSync(
    [owner.pubkey.toBuffer(), tokenProgram.pubkey.toBuffer(), mint.pubkey.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  if (!associatedAccount?.pubkey.equals(expectedAddress) || !associatedAccount.isWritable) {
    throw new Error("Rejected Associated Token creation with an invalid associated account.");
  }
}

const tradeInstructionPolicies = new Map<string, Map<string, TradeInstructionPolicy>>([
  [PUMP_PROGRAM_ID, new Map([
    [instructionKey([102, 6, 61, 18, 1, 218, 235, 234]), {
      action: "buy", instructionName: "buy", requiredAccountCount: 16,
      writableAccountIndexes: [1, 3, 4, 5, 6, 9, 13], mintAccountIndex: 2, userAccountIndex: 6,
      instructionDataLength: 25, maxSpendOffset: 16,
    }],
    [instructionKey([56, 252, 116, 8, 158, 223, 205, 95]), {
      action: "buy", instructionName: "buy_exact_sol_in", requiredAccountCount: 16,
      writableAccountIndexes: [1, 3, 4, 5, 6, 9, 13], mintAccountIndex: 2, userAccountIndex: 6,
      instructionDataLength: 25, maxSpendOffset: 8,
    }],
    [instructionKey([184, 23, 238, 97, 103, 197, 211, 61]), {
      action: "buy", instructionName: "buy_v2", requiredAccountCount: 27,
      writableAccountIndexes: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 21],
      mintAccountIndex: 1, userAccountIndex: 13,
      instructionDataLength: 24, maxSpendOffset: 16, quoteMintAccountIndex: 2,
    }],
    [instructionKey([194, 171, 28, 70, 104, 77, 91, 47]), {
      action: "buy", instructionName: "buy_exact_quote_in_v2", requiredAccountCount: 27,
      writableAccountIndexes: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 21],
      mintAccountIndex: 1, userAccountIndex: 13,
      instructionDataLength: 24, maxSpendOffset: 8, quoteMintAccountIndex: 2,
    }],
    [instructionKey([51, 230, 133, 164, 1, 127, 131, 173]), {
      action: "sell", instructionName: "sell", requiredAccountCount: 14,
      writableAccountIndexes: [1, 3, 4, 5, 6, 8], mintAccountIndex: 2, userAccountIndex: 6,
      instructionDataLength: 24, sellAmountOffset: 8, minOutputOffset: 16,
    }],
    [instructionKey([93, 246, 130, 60, 231, 233, 64, 178]), {
      action: "sell", instructionName: "sell_v2", requiredAccountCount: 26,
      writableAccountIndexes: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20],
      mintAccountIndex: 1, userAccountIndex: 13,
      instructionDataLength: 24, sellAmountOffset: 8, minOutputOffset: 16,
      quoteMintAccountIndex: 2,
    }],
  ])],
  [PUMP_SWAP_PROGRAM_ID, new Map([
    [instructionKey([102, 6, 61, 18, 1, 218, 235, 234]), {
      action: "buy", instructionName: "buy", requiredAccountCount: 23,
      writableAccountIndexes: [0, 1, 5, 6, 7, 8, 10, 17, 20],
      mintAccountIndex: 3, userAccountIndex: 1,
      instructionDataLength: 25, maxSpendOffset: 16, exactBaseOutputOffset: 8,
      quoteMintAccountIndex: 4, feeConfigAccountIndex: 21, feeProgramAccountIndex: 22,
    }],
    [instructionKey([198, 46, 21, 82, 180, 217, 232, 112]), {
      action: "buy", instructionName: "buy_exact_quote_in", requiredAccountCount: 23,
      writableAccountIndexes: [0, 1, 5, 6, 7, 8, 10, 17, 20],
      mintAccountIndex: 3, userAccountIndex: 1,
      instructionDataLength: 25, maxSpendOffset: 8, minOutputOffset: 16,
      quoteMintAccountIndex: 4, feeConfigAccountIndex: 21, feeProgramAccountIndex: 22,
    }],
    [instructionKey([51, 230, 133, 164, 1, 127, 131, 173]), {
      action: "sell", instructionName: "sell", requiredAccountCount: 21,
      writableAccountIndexes: [0, 1, 5, 6, 7, 8, 10, 17],
      mintAccountIndex: 3, userAccountIndex: 1,
      instructionDataLength: 24, sellAmountOffset: 8, minOutputOffset: 16,
      quoteMintAccountIndex: 4, feeConfigAccountIndex: 19, feeProgramAccountIndex: 20,
    }],
  ])],
]);

function assertTradeInstruction(
  programId: string,
  instructionData: Uint8Array,
  accountKeyIndexes: readonly number[],
  accountKeys: MessageAccountKeys,
  wallet: PublicKey,
  context: TransactionTradeContext,
  message: VersionedTransaction["message"],
): { amountRaw: bigint; pumpswapTrade?: PumpswapTrade } {
  if (instructionData.length < 8) {
    throw new Error(`Rejected ${programId} instruction with missing 8-byte discriminator.`);
  }
  const discriminator = instructionKey(instructionData.subarray(0, 8));
  const policy = tradeInstructionPolicies.get(programId)?.get(discriminator);
  if (!policy) {
    throw new Error(`Rejected unknown ${programId} instruction discriminator ${discriminator}.`);
  }
  if (policy.action !== context.action) {
    throw new Error(
      `Rejected ${programId} ${policy.action} instruction for requested ${context.action} action.`,
    );
  }
  if (instructionData.length !== policy.instructionDataLength) {
    throw new Error(
      `Rejected ${programId} ${policy.instructionName} instruction with ${instructionData.length} data bytes; expected ${policy.instructionDataLength}.`,
    );
  }
  if (accountKeyIndexes.length < policy.requiredAccountCount) {
    throw new Error(
      `Rejected ${programId} ${policy.instructionName} instruction with ${accountKeyIndexes.length} accounts; expected at least ${policy.requiredAccountCount}.`,
    );
  }

  const writableAccountIndexes = new Set(policy.writableAccountIndexes);
  for (let instructionIndex = 0; instructionIndex < policy.requiredAccountCount; instructionIndex += 1) {
    const accountKeyIndex = accountKeyIndexes[instructionIndex];
    if (accountKeyIndex === undefined) {
      throw new Error(`Rejected ${programId} ${policy.instructionName} instruction with a missing account.`);
    }
    const expectedSigner = instructionIndex === policy.userAccountIndex;
    if (message.isAccountSigner(accountKeyIndex) !== expectedSigner) {
      throw new Error(
        `Rejected ${programId} ${policy.instructionName} instruction with unexpected signer privilege at account ${instructionIndex}.`,
      );
    }
    const expectedWritable = writableAccountIndexes.has(instructionIndex);
    if (message.isAccountWritable(accountKeyIndex) !== expectedWritable) {
      throw new Error(
        `Rejected ${programId} ${policy.instructionName} instruction with unexpected writable privilege at account ${instructionIndex}.`,
      );
    }
  }

  const userKeyIndex = accountKeyIndexes[policy.userAccountIndex];
  const mintKeyIndex = accountKeyIndexes[policy.mintAccountIndex];
  const user = userKeyIndex === undefined ? undefined : accountKeys.get(userKeyIndex);
  const mint = mintKeyIndex === undefined ? undefined : accountKeys.get(mintKeyIndex);
  if (!user?.equals(wallet)) {
    throw new Error(`Rejected ${programId} trade whose user account is not the configured wallet.`);
  }
  if (!mint?.equals(context.mint)) {
    throw new Error(`Rejected ${programId} trade whose mint does not match the requested mint.`);
  }

  if (policy.quoteMintAccountIndex !== undefined) {
    const quoteMintKeyIndex = accountKeyIndexes[policy.quoteMintAccountIndex];
    const quoteMint = quoteMintKeyIndex === undefined ? undefined : accountKeys.get(quoteMintKeyIndex);
    if (quoteMint?.toBase58() !== WRAPPED_SOL_MINT) {
      throw new Error(`Rejected ${programId} trade whose quote mint is not wrapped SOL.`);
    }
  }

  let pumpswapAccounts: (PumpswapTradeAccounts & PumpswapFeeAccounts) | undefined;
  if (programId === PUMP_SWAP_PROGRAM_ID) {
    const accountAt = (instructionIndex: number, name: string): PublicKey => {
      const accountKeyIndex = accountKeyIndexes[instructionIndex];
      const account = accountKeyIndex === undefined ? undefined : accountKeys.get(accountKeyIndex);
      if (!account) throw new Error(`Rejected PumpSwap trade with unresolved ${name} account.`);
      return account;
    };
    const pool = accountAt(0, "pool");
    const baseMint = accountAt(3, "base mint");
    const quoteMint = accountAt(4, "quote mint");
    const poolBaseTokenAccount = accountAt(7, "pool base token");
    const poolQuoteTokenAccount = accountAt(8, "pool quote token");
    const globalConfig = accountAt(2, "global config");
    if (policy.feeConfigAccountIndex === undefined || policy.feeProgramAccountIndex === undefined) {
      throw new Error("Rejected PumpSwap trade without a pinned fee account layout.");
    }
    const feeConfig = accountAt(policy.feeConfigAccountIndex, "fee config");
    const feeProgram = accountAt(policy.feeProgramAccountIndex, "fee program");
    if (globalConfig.toBase58() !== PUMP_SWAP_GLOBAL_CONFIG_ADDRESS) {
      throw new Error("Rejected PumpSwap trade with an invalid global config account.");
    }
    if (feeConfig.toBase58() !== PUMP_SWAP_FEE_CONFIG_ADDRESS) {
      throw new Error("Rejected PumpSwap trade with an invalid fee config account.");
    }
    if (feeProgram.toBase58() !== PUMP_FEE_PROGRAM_ID) {
      throw new Error("Rejected PumpSwap trade with an invalid fee program account.");
    }
    const distinctAccounts = new Set([
      pool.toBase58(),
      baseMint.toBase58(),
      quoteMint.toBase58(),
      poolBaseTokenAccount.toBase58(),
      poolQuoteTokenAccount.toBase58(),
    ]);
    if (distinctAccounts.size !== 5) {
      throw new Error("Rejected PumpSwap trade with aliased pool, mint, or vault accounts.");
    }
    pumpswapAccounts = {
      poolAddress: pool.toBase58(),
      baseMint: baseMint.toBase58(),
      quoteMint: quoteMint.toBase58(),
      poolBaseTokenAccount: poolBaseTokenAccount.toBase58(),
      poolQuoteTokenAccount: poolQuoteTokenAccount.toBase58(),
      globalConfigAddress: globalConfig.toBase58(),
      feeConfigAddress: feeConfig.toBase58(),
      feeProgramAddress: feeProgram.toBase58(),
    };
  }

  const data = Buffer.from(instructionData);
  if (context.action === "sell") {
    if (policy.sellAmountOffset === undefined || policy.minOutputOffset === undefined) {
      throw new Error(`Rejected ${programId} sell instruction without a pinned argument layout.`);
    }
    const sellAmountRaw = data.readBigUInt64LE(policy.sellAmountOffset);
    const minOutputLamports = data.readBigUInt64LE(policy.minOutputOffset);
    if (sellAmountRaw === 0n) {
      throw new Error(`Rejected ${programId} ${policy.instructionName} instruction with zero token amount.`);
    }
    if (minOutputLamports === 0n) {
      throw new Error(`Rejected ${programId} ${policy.instructionName} instruction with zero minimum output.`);
    }
    return {
      amountRaw: sellAmountRaw,
      pumpswapTrade: pumpswapAccounts && {
        ...pumpswapAccounts,
        instructionName: "sell",
        inputSemantics: "exact-base-input",
        exactBaseInputRaw: sellAmountRaw,
        minQuoteOutputRaw: minOutputLamports,
      },
    };
  }
  if (policy.maxSpendOffset === undefined) {
    throw new Error(`Rejected ${programId} buy instruction without a pinned spend layout.`);
  }
  const maxSpendLamports = data.readBigUInt64LE(policy.maxSpendOffset);
  if (maxSpendLamports === 0n) {
    throw new Error(`Rejected ${programId} ${policy.instructionName} instruction with zero spend.`);
  }
  if (!pumpswapAccounts) return { amountRaw: maxSpendLamports };
  if (policy.instructionName === "buy") {
    if (policy.exactBaseOutputOffset === undefined) {
      throw new Error("Rejected PumpSwap buy instruction without a pinned exact output layout.");
    }
    const exactBaseOutputRaw = data.readBigUInt64LE(policy.exactBaseOutputOffset);
    if (exactBaseOutputRaw === 0n) {
      throw new Error("Rejected PumpSwap buy instruction with zero exact base output.");
    }
    return {
      amountRaw: maxSpendLamports,
      pumpswapTrade: {
        ...pumpswapAccounts,
        instructionName: "buy",
        inputSemantics: "maximum-quote-input",
        exactBaseOutputRaw,
        maxQuoteInputRaw: maxSpendLamports,
      },
    };
  }
  if (policy.instructionName === "buy_exact_quote_in" && policy.minOutputOffset !== undefined) {
    const minBaseOutputRaw = data.readBigUInt64LE(policy.minOutputOffset);
    if (minBaseOutputRaw === 0n) {
      throw new Error("Rejected PumpSwap buy_exact_quote_in instruction with zero minimum base output.");
    }
    return {
      amountRaw: maxSpendLamports,
      pumpswapTrade: {
        ...pumpswapAccounts,
        instructionName: "buy_exact_quote_in",
        inputSemantics: "exact-quote-input",
        exactQuoteInputRaw: maxSpendLamports,
        minBaseOutputRaw,
      },
    };
  }
  throw new Error(`Rejected PumpSwap ${policy.instructionName} instruction without pinned semantics.`);
}

export function assertResolvedTransactionPolicyDetails(
  transaction: VersionedTransaction,
  wallet: PublicKey,
  allowedProgramIds: readonly string[],
  accountKeys: MessageAccountKeys,
  context: TransactionTradeContext,
): TransactionPolicyDetails {
  const { message } = transaction;
  if (message.header.numRequiredSignatures !== 1) {
    throw new Error(
      `Rejected transaction requiring ${message.header.numRequiredSignatures} signers; expected exactly one.`,
    );
  }

  const feePayer = accountKeys.get(0);
  if (!feePayer?.equals(wallet)) {
    throw new Error("Rejected transaction whose fee payer and sole signer is not the configured wallet.");
  }

  const allowedPrograms = new Set(
    allowedProgramIds.map((programId) => new PublicKey(programId).toBase58()),
  );
  const invokedPrograms = message.compiledInstructions.map((instruction) => {
    const programId = accountKeys.get(instruction.programIdIndex);
    if (!programId) {
      throw new Error(`Rejected transaction with invalid program index ${instruction.programIdIndex}.`);
    }
    return programId.toBase58();
  });

  const unknownPrograms = [...new Set(invokedPrograms)]
    .filter((programId) => !allowedPrograms.has(programId));
  if (unknownPrograms.length > 0) {
    throw new Error(`Rejected unallowlisted transaction program(s): ${unknownPrograms.join(", ")}`);
  }
  if (!invokedPrograms.some((programId) => supportedTradePrograms.has(programId))) {
    throw new Error("Rejected transaction that does not invoke an explicitly supported Pump program.");
  }
  let aggregateSpendLamports = 0n;
  const pumpswapTrades: PumpswapTrade[] = [];
  let computeUnitLimit: number | undefined;
  let computeUnitPriceMicroLamports: bigint | undefined;
  message.compiledInstructions.forEach((instruction, index) => {
    const programId = invokedPrograms[index];
    if (programId && supportedTradePrograms.has(programId)) {
      const trade = assertTradeInstruction(
        programId,
        instruction.data,
        instruction.accountKeyIndexes,
        accountKeys,
        wallet,
        context,
        message,
      );
      aggregateSpendLamports += trade.amountRaw;
      if (trade.pumpswapTrade) pumpswapTrades.push(trade.pumpswapTrade);
      return;
    }
    const programKey = accountKeys.get(instruction.programIdIndex);
    if (!programId || !programKey) {
      throw new Error("Rejected instruction with an unresolved program.");
    }
    const decodedInstruction = resolvedInstruction(
      programKey,
      instruction.data,
      instruction.accountKeyIndexes,
      accountKeys,
      message,
    );
    if (programId === COMPUTE_BUDGET_PROGRAM_ID) {
      let instructionType: ReturnType<typeof ComputeBudgetInstruction.decodeInstructionType>;
      try {
        instructionType = ComputeBudgetInstruction.decodeInstructionType(decodedInstruction);
      } catch {
        throw new Error("Rejected malformed Compute Budget instruction.");
      }
      if (instructionType === "SetComputeUnitLimit") {
        if (computeUnitLimit !== undefined) {
          throw new Error("Rejected duplicate compute unit limit instruction.");
        }
        computeUnitLimit = ComputeBudgetInstruction.decodeSetComputeUnitLimit(decodedInstruction).units;
        if (computeUnitLimit <= 0 || computeUnitLimit > MAX_COMPUTE_UNITS) {
          throw new Error(`Rejected compute unit limit ${computeUnitLimit}.`);
        }
        return;
      }
      if (instructionType === "SetComputeUnitPrice") {
        if (computeUnitPriceMicroLamports !== undefined) {
          throw new Error("Rejected duplicate compute unit price instruction.");
        }
        const { microLamports } = ComputeBudgetInstruction.decodeSetComputeUnitPrice(decodedInstruction);
        computeUnitPriceMicroLamports = BigInt(microLamports);
        return;
      }
      throw new Error(`Rejected unsupported Compute Budget instruction ${instructionType}.`);
    }
    if (programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
      assertAssociatedTokenInstruction(decodedInstruction, wallet, context);
      return;
    }
    if (programId === SYSTEM_PROGRAM_ID) {
      throw new Error("Rejected top-level System Program instruction.");
    }
    if (programId === SPL_TOKEN_PROGRAM_ID) {
      throw new Error("Rejected top-level SPL Token instruction.");
    }
    throw new Error(`Rejected program ${programId} because it has no instruction policy.`);
  });
  if (context.action === "buy" && aggregateSpendLamports > context.maxSpendLamports) {
    throw new Error(
      `Rejected transaction spending up to ${aggregateSpendLamports} lamports; requested maximum is ${context.maxSpendLamports}.`,
    );
  }
  if (context.action === "sell" && aggregateSpendLamports > context.maxSellAmountRaw) {
    throw new Error(
      `Rejected transaction selling ${aggregateSpendLamports} raw token units; requested maximum is ${context.maxSellAmountRaw}.`,
    );
  }
  const priorityFeeLamports = (
    BigInt(computeUnitLimit ?? MAX_COMPUTE_UNITS)
    * (computeUnitPriceMicroLamports ?? 0n)
    + 999_999n
  ) / 1_000_000n;
  if (priorityFeeLamports > context.maxPriorityFeeLamports) {
    throw new Error(
      `Rejected transaction priority fee up to ${priorityFeeLamports} lamports; configured maximum is ${context.maxPriorityFeeLamports}.`,
    );
  }
  return {
    invokedPrograms,
    computeUnitLimit: computeUnitLimit ?? MAX_COMPUTE_UNITS,
    computeUnitPriceMicroLamports: computeUnitPriceMicroLamports ?? 0n,
    maxPriorityFeeLamports: priorityFeeLamports,
    pumpswapTrades,
  };
}

export function assertResolvedTransactionPolicy(
  transaction: VersionedTransaction,
  wallet: PublicKey,
  allowedProgramIds: readonly string[],
  accountKeys: MessageAccountKeys,
  context: TransactionTradeContext,
): string[] {
  return assertResolvedTransactionPolicyDetails(
    transaction,
    wallet,
    allowedProgramIds,
    accountKeys,
    context,
  ).invokedPrograms;
}

export async function assertTransactionPolicyDetails(
  transaction: VersionedTransaction,
  wallet: PublicKey,
  allowedProgramIds: readonly string[],
  connection: Connection,
  context: TransactionTradeContext,
): Promise<TransactionPolicyDetails> {
  const { message } = transaction;
  let accountKeys: MessageAccountKeys;
  if (message.version === "legacy") {
    accountKeys = message.getAccountKeys();
  } else {
    const lookupTables: AddressLookupTableAccount[] = [];
    for (const lookup of message.addressTableLookups) {
      const response = await connection.getAddressLookupTable(lookup.accountKey);
      if (!response.value) {
        throw new Error(`Rejected transaction with unavailable lookup table ${lookup.accountKey.toBase58()}.`);
      }
      lookupTables.push(response.value);
    }
    accountKeys = message.getAccountKeys({ addressLookupTableAccounts: lookupTables });
  }

  return assertResolvedTransactionPolicyDetails(
    transaction,
    wallet,
    allowedProgramIds,
    accountKeys,
    context,
  );
}

export async function assertTransactionPolicy(
  transaction: VersionedTransaction,
  wallet: PublicKey,
  allowedProgramIds: readonly string[],
  connection: Connection,
  context: TransactionTradeContext,
): Promise<string[]> {
  return (await assertTransactionPolicyDetails(
    transaction,
    wallet,
    allowedProgramIds,
    connection,
    context,
  )).invokedPrograms;
}