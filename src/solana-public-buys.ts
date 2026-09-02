import {
  type Connection,
  LAMPORTS_PER_SOL,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import { PUMP_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID, WRAPPED_SOL_MINT } from "./transaction-policy.js";

export interface ConfirmedPublicBuy {
  signature: string;
  mint: string;
  walletDecreaseSol: number;
  confirmedAt: string;
}

interface BuyLayout {
  programId: string;
  discriminator: string;
  dataLength: number;
  mintIndex: number;
  userIndex: number;
  quoteMintIndex?: number;
}

const discriminator = (bytes: readonly number[]): string => Buffer.from(bytes).toString("hex");

const buyLayouts: BuyLayout[] = [
  { programId: PUMP_PROGRAM_ID, discriminator: discriminator([102, 6, 61, 18, 1, 218, 235, 234]), dataLength: 25, mintIndex: 2, userIndex: 6 },
  { programId: PUMP_PROGRAM_ID, discriminator: discriminator([102, 6, 61, 18, 1, 218, 235, 234]), dataLength: 24, mintIndex: 2, userIndex: 6 },
  { programId: PUMP_PROGRAM_ID, discriminator: discriminator([56, 252, 116, 8, 158, 223, 205, 95]), dataLength: 25, mintIndex: 2, userIndex: 6 },
  { programId: PUMP_PROGRAM_ID, discriminator: discriminator([184, 23, 238, 97, 103, 197, 211, 61]), dataLength: 24, mintIndex: 1, userIndex: 13, quoteMintIndex: 2 },
  { programId: PUMP_PROGRAM_ID, discriminator: discriminator([194, 171, 28, 70, 104, 77, 91, 47]), dataLength: 24, mintIndex: 1, userIndex: 13, quoteMintIndex: 2 },
  { programId: PUMP_SWAP_PROGRAM_ID, discriminator: discriminator([102, 6, 61, 18, 1, 218, 235, 234]), dataLength: 25, mintIndex: 3, userIndex: 1, quoteMintIndex: 4 },
  { programId: PUMP_SWAP_PROGRAM_ID, discriminator: discriminator([198, 46, 21, 82, 180, 217, 232, 112]), dataLength: 25, mintIndex: 3, userIndex: 1, quoteMintIndex: 4 },
];

function isPartiallyDecoded(
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
): instruction is PartiallyDecodedInstruction {
  return "data" in instruction && "accounts" in instruction;
}

function tokenBalancesByOwner(
  balances: NonNullable<ParsedTransactionWithMeta["meta"]>["preTokenBalances"],
  mint: string,
): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const balance of balances ?? []) {
    if (balance.mint !== mint || !balance.owner) continue;
    totals.set(balance.owner, (totals.get(balance.owner) ?? 0n) + BigInt(balance.uiTokenAmount.amount));
  }
  return totals;
}

function buyerWithPositiveTokenDelta(transaction: ParsedTransactionWithMeta, mint: string): string | undefined {
  const before = tokenBalancesByOwner(transaction.meta?.preTokenBalances, mint);
  const after = tokenBalancesByOwner(transaction.meta?.postTokenBalances, mint);
  return [...after].find(([owner, amount]) => amount > (before.get(owner) ?? 0n))?.[0];
}

function transactionInstructions(
  transaction: ParsedTransactionWithMeta,
): Array<ParsedInstruction | PartiallyDecodedInstruction> {
  return [
    ...transaction.transaction.message.instructions,
    ...(transaction.meta?.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
}

function recognizedBuyer(
  transaction: ParsedTransactionWithMeta,
  mint: string,
): string | undefined {
  for (const instruction of transactionInstructions(transaction)) {
    if (!isPartiallyDecoded(instruction)) continue;
    let data: Buffer;
    try {
      data = Buffer.from(bs58.decode(instruction.data));
    } catch {
      continue;
    }
    const layout = buyLayouts.find((candidate) =>
      candidate.programId === instruction.programId.toBase58()
      && candidate.dataLength === data.length
      && candidate.discriminator === data.subarray(0, 8).toString("hex"));
    if (!layout) continue;
    if (instruction.accounts[layout.mintIndex]?.toBase58() !== mint) continue;
    if (layout.quoteMintIndex !== undefined
      && instruction.accounts[layout.quoteMintIndex]?.toBase58() !== WRAPPED_SOL_MINT) continue;
    return instruction.accounts[layout.userIndex]?.toBase58();
  }
  return undefined;
}

export function decodeConfirmedPublicBuy(
  signature: string,
  transaction: ParsedTransactionWithMeta,
  mint: string,
): ConfirmedPublicBuy | undefined {
  if (!transaction.meta || transaction.meta.err !== null || transaction.blockTime == null) return undefined;
  const balanceBuyer = buyerWithPositiveTokenDelta(transaction, mint);
  const instructionBuyer = recognizedBuyer(transaction, mint);
  if (!balanceBuyer || balanceBuyer !== instructionBuyer) return undefined;
  const accountIndex = transaction.transaction.message.accountKeys
    .findIndex((account) => account.pubkey.toBase58() === instructionBuyer);
  if (accountIndex < 0) return undefined;
  const walletDecreaseLamports = (transaction.meta.preBalances[accountIndex] ?? 0)
    - (transaction.meta.postBalances[accountIndex] ?? 0);
  if (walletDecreaseLamports <= 0) return undefined;
  return {
    signature,
    mint,
    walletDecreaseSol: walletDecreaseLamports / LAMPORTS_PER_SOL,
    confirmedAt: new Date(transaction.blockTime * 1_000).toISOString(),
  };
}

export async function readConfirmedPublicBuys(
  connection: Connection,
  mint: string,
  minimumSol: number,
  observedSignatures: Set<string>,
  lookbackSeconds: number,
  nowMs = Date.now(),
): Promise<ConfirmedPublicBuy[]> {
  const signatures = await connection.getSignaturesForAddress(new PublicKey(mint), { limit: 100 }, "confirmed");
  const cutoffSeconds = Math.floor(nowMs / 1_000) - lookbackSeconds;
  const candidates = signatures.filter((entry) => {
    if (observedSignatures.has(entry.signature)) return false;
    if (entry.err || entry.blockTime == null || entry.blockTime < cutoffSeconds) {
      observedSignatures.add(entry.signature);
      return false;
    }
    return true;
  });
  if (candidates.length === 0) return [];
  const transactions = await connection.getParsedTransactions(
    candidates.map((entry) => entry.signature),
    { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  );
  const buys: ConfirmedPublicBuy[] = [];
  for (const transaction of transactions) {
    if (!transaction) continue;
    const actualSignature = transaction.transaction.signatures[0];
    if (!actualSignature || observedSignatures.has(actualSignature)) continue;
    const buy = decodeConfirmedPublicBuy(actualSignature, transaction, mint);
    if (buy && buy.walletDecreaseSol >= minimumSol) buys.push(buy);
    else observedSignatures.add(actualSignature);
  }
  return buys.sort((left, right) => left.confirmedAt.localeCompare(right.confirmedAt));
}