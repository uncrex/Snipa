import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Connection } from "@solana/web3.js";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { tradeJournalEntrySchema } from "./journal.js";
import {
  readPumpBondingProgress,
  type PumpBondingProgress,
} from "./pump-bonding-progress.js";
import { readConfirmedPublicBuys } from "./solana-public-buys.js";
import type { TelegramConfig } from "./telegram-config.js";
import { escapeTelegramHtml } from "./telegram-content.js";

export interface ConfirmedBuyAlert {
  signature: string;
  mint: string;
  requestedSol: number;
  finalizedAt: string;
  sizeKind?: "requested" | "wallet-decrease";
}

export function confirmedBuyAlerts(
  contents: string,
  mint: string,
  minimumSol: number,
  sentSignatures: ReadonlySet<string> = new Set(),
): ConfirmedBuyAlert[] {
  if (!Number.isFinite(minimumSol) || minimumSol <= 0) {
    throw new Error("Telegram buy alert minimum must be positive.");
  }
  const alerts = new Map<string, ConfirmedBuyAlert>();
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let input: unknown;
    try {
      input = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const parsed = tradeJournalEntrySchema.safeParse(input);
    if (!parsed.success) continue;
    const entry = parsed.data;
    if (entry.schemaVersion !== 2
      || entry.mode !== "LIVE"
      || entry.status !== "confirmed"
      || entry.action !== "buy"
      || entry.mint !== mint
      || !entry.denominatedInSol
      || typeof entry.amount !== "number"
      || entry.amount < minimumSol
      || !entry.signature
      || !entry.finalizedAt
      || sentSignatures.has(entry.signature)) continue;
    alerts.set(entry.signature, {
      signature: entry.signature,
      mint: entry.mint,
      requestedSol: entry.amount,
      finalizedAt: entry.finalizedAt,
    });
  }
  return [...alerts.values()].sort((left, right) => left.finalizedAt.localeCompare(right.finalizedAt));
}

export function formatBondingProgress(progress?: PumpBondingProgress): string {
  if (!progress) return "Bonding: <b>Unavailable</b>";
  const percentage = (progress.progressBps / 100).toFixed(1);
  const filled = Math.round(progress.progressBps / 1_000);
  const bar = `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
  const status = progress.complete ? "Bonded / Migrated" : "Active";
  return `Bonding: <b>${bar} ${percentage}%</b>\nStatus: <b>${status}</b>`;
}

export function formatCurrentMarketCap(progress?: PumpBondingProgress): string {
  if (!progress || progress.currentMarketCapUsd === undefined) {
    return "Current Market Cap: <b>Unavailable</b>";
  }
  const marketCap = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(progress.currentMarketCapUsd);
  return `Current Market Cap: <b>${marketCap}</b>`;
}

export function formatConfirmedBuyAlert(
  alert: ConfirmedBuyAlert,
  config: TelegramConfig,
  bondingProgress?: PumpBondingProgress,
): string {
  const signature = encodeURIComponent(alert.signature);
  return [
    `<b>${escapeTelegramHtml(config.TELEGRAM_PROJECT_NAME)} confirmed buy</b>`,
    `${alert.sizeKind === "wallet-decrease" ? "Buyer wallet decrease" : "Requested size"}: <b>${alert.requestedSol} SOL</b>`,
    formatCurrentMarketCap(bondingProgress),
    formatBondingProgress(bondingProgress),
    `CA: <code>${escapeTelegramHtml(alert.mint)}</code>`,
    `<a href="https://solscan.io/tx/${signature}">Verified transaction</a>`,
  ].join("\n");
}

export function confirmedBuyKeyboard(
  alert: ConfirmedBuyAlert,
  config: TelegramConfig,
): InlineKeyboard {
  const transactionUrl = `https://solscan.io/tx/${encodeURIComponent(alert.signature)}`;
  const chartUrl = `https://dexscreener.com/solana/${encodeURIComponent(alert.mint)}`;
  const shareUrl = "https://t.me/share/url"
    + `?url=${encodeURIComponent(config.TELEGRAM_TOKEN_URL)}`
    + `&text=${encodeURIComponent(`${config.TELEGRAM_PROJECT_NAME} on Solana`)}`;
  return new InlineKeyboard()
    .url("Buy", config.TELEGRAM_TOKEN_URL)
    .url("Chart", chartUrl)
    .row()
    .url("Verify", transactionUrl)
    .url("Website", config.TELEGRAM_WEBSITE_URL)
    .row()
    .url("Vote CoinSniper", config.TELEGRAM_COINSNIPER_URL)
    .url("Vote CoinMooner", config.TELEGRAM_COINMOONER_URL)
    .row()
    .url("Vote CoinBuzzer", config.TELEGRAM_COINBUZZER_URL)
    .url("Vote Coinscope", config.TELEGRAM_COINSCOPE_URL)
    .row()
    .url("Rocket DexScreener", config.TELEGRAM_DEXSCREENER_URL)
    .row()
    .url("Share", shareUrl);
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function readSentSignatures(path: string): Promise<Set<string>> {
  const signatures = new Set<string>();
  for (const line of (await readOptional(path)).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const input = JSON.parse(line) as { signature?: unknown };
      if (typeof input.signature === "string") signatures.add(input.signature);
    } catch {
      continue;
    }
  }
  return signatures;
}

async function markSent(
  path: string,
  signature: string,
  chatId: string,
  messageId: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({
    signature,
    chatId,
    messageId,
    sentAt: new Date().toISOString(),
  })}\n`, "utf8");
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function startTelegramAlerts(telegramConfig: TelegramConfig): Promise<void> {
  if (!telegramConfig.TELEGRAM_ALERT_BOT_TOKEN) {
    throw new Error("TELEGRAM_ALERT_BOT_TOKEN is required for telegram-alerts.");
  }
  if (!telegramConfig.TELEGRAM_GROUP_CHAT_ID) {
    throw new Error("TELEGRAM_GROUP_CHAT_ID is required for telegram-alerts.");
  }
  const bot = new Bot(telegramConfig.TELEGRAM_ALERT_BOT_TOKEN);
  const connection = new Connection(telegramConfig.SOLANA_RPC_URL, "confirmed");
  await bot.api.getMe();
  console.log(`@${telegramConfig.TELEGRAM_ALERT_BOT_USERNAME} is watching confirmed WETZEL buys.`);
  const sentSignatures = await readSentSignatures(telegramConfig.TELEGRAM_ALERT_SENT_LOG_PATH);
  const observedPublicSignatures = new Set(sentSignatures);
  while (true) {
    try {
      const journalAlerts = confirmedBuyAlerts(
        await readOptional(telegramConfig.TRADE_JOURNAL_PATH),
        telegramConfig.TELEGRAM_ALERT_MINT,
        telegramConfig.TELEGRAM_BUY_ALERT_MIN_SOL,
        sentSignatures,
      );
      let publicAlerts: ConfirmedBuyAlert[] = [];
      try {
        publicAlerts = (await readConfirmedPublicBuys(
          connection,
          telegramConfig.TELEGRAM_ALERT_MINT,
          telegramConfig.TELEGRAM_BUY_ALERT_MIN_SOL,
          observedPublicSignatures,
          telegramConfig.TELEGRAM_PUBLIC_BUY_LOOKBACK_SECONDS,
        )).map((buy): ConfirmedBuyAlert => ({
          signature: buy.signature,
          mint: buy.mint,
          requestedSol: buy.walletDecreaseSol,
          finalizedAt: buy.confirmedAt,
          sizeKind: "wallet-decrease",
        }));
      } catch (error) {
        console.error(`Public buy scan unavailable: ${error instanceof Error ? error.message : error}`);
      }
      const alerts = [...new Map(
        [...journalAlerts, ...publicAlerts]
          .filter((alert) => !sentSignatures.has(alert.signature))
          .map((alert) => [alert.signature, alert]),
      ).values()].sort((left, right) => left.finalizedAt.localeCompare(right.finalizedAt));
      for (const alert of alerts) {
        let bondingProgress: PumpBondingProgress | undefined;
        try {
          bondingProgress = await readPumpBondingProgress(connection, alert.mint);
        } catch (error) {
          console.error(`Bonding progress unavailable: ${error instanceof Error ? error.message : error}`);
        }
        const message = await bot.api.sendAnimation(
          telegramConfig.TELEGRAM_GROUP_CHAT_ID,
          new InputFile(telegramConfig.TELEGRAM_ALERT_ANIMATION_PATH),
          {
            caption: formatConfirmedBuyAlert(alert, telegramConfig, bondingProgress),
            parse_mode: "HTML",
            reply_markup: confirmedBuyKeyboard(alert, telegramConfig),
          },
        );
        await markSent(
          telegramConfig.TELEGRAM_ALERT_SENT_LOG_PATH,
          alert.signature,
          telegramConfig.TELEGRAM_GROUP_CHAT_ID,
          message.message_id,
        );
        sentSignatures.add(alert.signature);
        observedPublicSignatures.add(alert.signature);
      }
    } catch (error) {
      console.error(`Telegram alert error: ${error instanceof Error ? error.message : error}`);
    }
    await wait(telegramConfig.TELEGRAM_ALERT_POLL_INTERVAL_MS);
  }
}