import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import "dotenv/config";

const mint = "9PyFGTA7DoC4PJ38XRMKCW4M5mkSy59PVXuCKHuzpump";
const wallet = Keypair.generate().publicKey;
const response = await fetch("https://pumpportal.fun/api/trade-local", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    publicKey: wallet.toBase58(),
    action: "buy",
    mint,
    amount: 0.001,
    denominatedInSol: "true",
    slippage: 5,
    priorityFee: 0.00005,
    pool: "auto",
  }),
});
if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
const transaction = VersionedTransaction.deserialize(new Uint8Array(await response.arrayBuffer()));
const connection = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const lookupTables = [];
for (const lookup of transaction.message.addressTableLookups) {
  const table = await connection.getAddressLookupTable(lookup.accountKey);
  if (!table.value) throw new Error(`Missing lookup table ${lookup.accountKey.toBase58()}`);
  lookupTables.push(table.value);
}
const keys = transaction.message.getAccountKeys({ addressLookupTableAccounts: lookupTables });
const mintAccount = await connection.getAccountInfo(new PublicKey(mint), "confirmed");
console.log(JSON.stringify({
  mintOwner: mintAccount?.owner.toBase58(),
  mintDataLength: mintAccount?.data.length,
  instructions: transaction.message.compiledInstructions.map((instruction) => ({
    program: keys.get(instruction.programIdIndex)?.toBase58(),
    dataHex: Buffer.from(instruction.data).toString("hex"),
    accounts: [...instruction.accountKeyIndexes].map((index) => ({
      address: keys.get(index)?.toBase58(),
      signer: transaction.message.isAccountSigner(index),
      writable: transaction.message.isAccountWritable(index),
    })),
  })),
}, null, 2));
