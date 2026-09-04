import {
  type AddressLookupTableAccount,
  type Connection,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./transaction-policy.js";

interface PhantomBuyRequest {
  mint: string;
  amountSol: number;
  publicKey: string;
  slippagePercent: number;
  priorityFeeSol: number;
}

type RouteFetcher = (input: string, init: RequestInit) => Promise<Response>;

export async function assertPhantomTransactionEnvelope(
  transaction: VersionedTransaction,
  wallet: PublicKey,
  mint: PublicKey,
  connection: Pick<Connection, "getAddressLookupTable" | "getAccountInfo">,
): Promise<void> {
  if (transaction.message.header.numRequiredSignatures !== 1
    || transaction.signatures.length !== 1) {
    throw new Error("Phantom transaction must require exactly one signer.");
  }
  if (transaction.signatures[0]?.some((byte) => byte !== 0)) {
    throw new Error("Phantom transaction unexpectedly contains a signature.");
  }

  const lookupTables: AddressLookupTableAccount[] = [];
  for (const lookup of transaction.message.addressTableLookups) {
    const response = await connection.getAddressLookupTable(lookup.accountKey);
    if (!response.value) {
      throw new Error(`Phantom transaction lookup table is unavailable: ${lookup.accountKey.toBase58()}.`);
    }
    lookupTables.push(response.value);
  }
  const accountKeys = transaction.message.getAccountKeys({
    addressLookupTableAccounts: lookupTables,
  });
  if (!accountKeys.get(0)?.equals(wallet)) {
    throw new Error("Phantom transaction fee payer does not match the connected wallet.");
  }
  const resolvedKeys = Array.from(
    { length: accountKeys.length },
    (_, index) => accountKeys.get(index),
  );
  if (!resolvedKeys.some((key) => key?.equals(mint))) {
    throw new Error("Phantom transaction does not reference the requested mint.");
  }

  const mintAccount = await connection.getAccountInfo(mint, "confirmed");
  if (!mintAccount || mintAccount.executable) {
    throw new Error("Requested mint account is unavailable or executable.");
  }
  const owner = mintAccount.owner.toBase58();
  if (owner !== SPL_TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) {
    throw new Error(`Requested mint owner ${owner} is not a supported token program.`);
  }
}

export async function buildPhantomBuyTransaction(
  request: PhantomBuyRequest,
  connection: Pick<Connection, "getAddressLookupTable" | "getAccountInfo">,
  routeFetcher: RouteFetcher = fetch,
): Promise<Uint8Array> {
  const wallet = new PublicKey(request.publicKey);
  const mint = new PublicKey(request.mint);
  const response = await routeFetcher("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: wallet.toBase58(),
      action: "buy",
      mint: mint.toBase58(),
      amount: request.amountSol,
      denominatedInSol: "true",
      slippage: request.slippagePercent,
      priorityFee: request.priorityFeeSol,
      pool: "auto",
    }),
  });
  if (!response.ok) {
    throw new Error(`PumpPortal rejected the Phantom trade (${response.status}): ${await response.text()}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const transaction = VersionedTransaction.deserialize(bytes);
  await assertPhantomTransactionEnvelope(transaction, wallet, mint, connection);
  return bytes;
}
