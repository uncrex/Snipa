import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { readTradeHistory } from "./history.js";
import { monitorTokens } from "./monitor.js";
import { startScannerApi } from "./scanner-api.js";
import { executeTrade, type TradeAction } from "./trader.js";
import { loadWallet } from "./wallet.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || ![
    "wallet", "monitor", "trade", "history", "dashboard-api",
  ].includes(command)) {
    throw new Error("Usage: npm run <wallet|monitor|trade|history|dashboard-api> [-- <buy|sell> <mint> <amount>]");
  }

  const config = loadConfig();

  if (command === "history") {
    const history = await readTradeHistory(
      config.TRADE_JOURNAL_PATH,
      config.SUBMISSION_CONFIRMATION_ALERT_MS,
    );
    if (history.missing) {
      console.log(`No trade journal found at ${config.TRADE_JOURNAL_PATH}.`);
      return;
    }
    console.log(`Trades: ${history.records} (${history.live} live, ${history.paper} paper)`);
    console.log(`Buys: ${history.buys} | Recorded SOL spend: ${history.buySpendSol}`);
    console.log(`Sells: ${history.sells} | Invalid lines skipped: ${history.invalidLines}`);
    const confirmation = history.submissionToConfirmation;
    console.log(
      `Submission-to-confirmation observation: ${confirmation.sampleCount} samples | `
      + `P50: ${confirmation.p50Ms ?? "n/a"} ms | P95: ${confirmation.p95Ms ?? "n/a"} ms | `
      + `Max: ${confirmation.maxMs ?? "n/a"} ms | Invalid pairs: ${confirmation.invalidSamples}`,
    );
    if (confirmation.alertThresholdMs !== null) {
      const status = confirmation.p95WithinThreshold === null
        ? "NO_SAMPLES"
        : confirmation.p95WithinThreshold ? "OK" : "ALERT";
      console.log(
        `Confirmation observation threshold: ${confirmation.alertThresholdMs} ms | `
        + `Above threshold: ${confirmation.aboveThresholdSamples} | P95 status: ${status}`,
      );
    }
    return;
  }
  if (command === "dashboard-api") {
    await startScannerApi(
      config.DASHBOARD_EVENT_LOG_PATH,
      config.DASHBOARD_API_HOST,
      config.DASHBOARD_API_PORT,
      config.DASHBOARD_PROJECTION_STALE_AFTER_MS,
    );
    console.log(`Scanner dashboard listening on http://${config.DASHBOARD_API_HOST}:${config.DASHBOARD_API_PORT}`);
    return;
  }
  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  if (command === "monitor") {
    await monitorTokens(config, config.AUTO_BUY ? await loadWallet(config) : undefined, connection);
    return;
  }
  const wallet = await loadWallet(config);
  if (command === "wallet") {
    const balance = await connection.getBalance(wallet.publicKey);
    console.log(`Address: ${wallet.publicKey.toBase58()}`);
    console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    return;
  }
  const action = process.argv[3] as TradeAction | undefined;
  const mint = process.argv[4];
  const rawAmount = process.argv[5];
  if (!action || !["buy", "sell"].includes(action) || !mint || !rawAmount) {
    throw new Error("Usage: npm run trade -- <buy|sell> <mint> <amount|percentage>");
  }
  new PublicKey(mint);
  const amount = rawAmount.endsWith("%") ? rawAmount : Number(rawAmount);
  if (typeof amount === "number" && (!Number.isFinite(amount) || amount <= 0)) {
    throw new Error("Amount must be a positive number or sell percentage.");
  }
  if (action === "buy" && typeof amount !== "number") {
    throw new Error("Buy amount must be a number of SOL.");
  }

  const signature = await executeTrade({
    action,
    mint,
    amount,
    denominatedInSol: action === "buy",
  }, config, wallet, connection);
  if (signature) console.log(`Confirmed: https://solscan.io/tx/${signature}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});