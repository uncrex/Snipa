import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confirmedBuyAlerts,
  confirmedBuyKeyboard,
  formatBondingProgress,
  formatConfirmedBuyAlert,
} from "./telegram-alerts.js";
import { parseTelegramConfig } from "./telegram-config.js";

function record(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    decisionId: "550e8400-e29b-41d4-a716-446655440000",
    timestamp: "2026-08-31T12:00:00.000Z",
    finalizedAt: "2026-08-31T12:00:01.000Z",
    action: "buy",
    mint: "FYwxAEKhksrMFeUgxwRE99Jn3BcdzK3Y1JPUbkf3pump",
    amount: 0.05,
    denominatedInSol: true,
    mode: "LIVE",
    wallet: "wallet",
    signature: "signature-a",
    status: "confirmed",
    ...overrides,
  });
}

test("confirmed buy alerts require matching live finalized journal records", () => {
  const contents = [
    record(),
    record({ signature: "too-small", amount: 0.049 }),
    record({ signature: "paper", mode: "PAPER" }),
    record({ signature: "submitted", status: "submitted", finalizedAt: null }),
    record({ signature: "wrong-mint", mint: "other" }),
    "not-json",
  ].join("\n");
  const alerts = confirmedBuyAlerts(
    contents,
    "FYwxAEKhksrMFeUgxwRE99Jn3BcdzK3Y1JPUbkf3pump",
    0.05,
  );
  assert.deepEqual(alerts.map((alert) => alert.signature), ["signature-a"]);
  assert.equal(confirmedBuyAlerts(contents, alerts[0]!.mint, 0.05, new Set(["signature-a"])).length, 0);
});

test("confirmed buy alert text identifies requested size and verified transaction", () => {
  const config = parseTelegramConfig({});
  const message = formatConfirmedBuyAlert({
    signature: "signature-a",
    mint: config.TELEGRAM_ALERT_MINT,
    requestedSol: 0.05,
    finalizedAt: "2026-08-31T12:00:01.000Z",
  }, config);
  assert.match(message, /Requested size: <b>0\.05 SOL<\/b>/);
  assert.match(message, /Current Market Cap: <b>Unavailable<\/b>/);
  assert.match(message, /Bonding: <b>Unavailable<\/b>/);
  assert.match(message, new RegExp(`CA: <code>${config.TELEGRAM_ALERT_MINT}<\\/code>`));
  assert.doesNotMatch(message, /Mint:/);
  assert.match(message, /https:\/\/solscan\.io\/tx\/signature-a/);
  assert.match(formatConfirmedBuyAlert({
    signature: "signature-b",
    mint: config.TELEGRAM_ALERT_MINT,
    requestedSol: 0.1,
    finalizedAt: "2026-08-31T12:00:01.000Z",
    sizeKind: "wallet-decrease",
  }, config), /Buyer wallet decrease: <b>0\.1 SOL<\/b>/);
});

test("bonding progress formats active and completed states", () => {
  assert.match(
    formatBondingProgress({ progressBps: 7_240, complete: false, currentMarketCapSol: 12.5 }),
    /███████░░░ 72\.4%<\/b>\nStatus: <b>Active/,
  );
  assert.match(
    formatBondingProgress({ progressBps: 10_000, complete: true, currentMarketCapSol: 12.5 }),
    /██████████ 100\.0%<\/b>\nStatus: <b>Bonded \/ Migrated/,
  );
});

test("confirmed buy alert displays current market cap in US dollars", () => {
  const config = parseTelegramConfig({});
  const message = formatConfirmedBuyAlert({
    signature: "signature-a",
    mint: config.TELEGRAM_ALERT_MINT,
    requestedSol: 0.05,
    finalizedAt: "2026-08-31T12:00:01.000Z",
  }, config, {
    progressBps: 7_240,
    complete: false,
    currentMarketCapSol: 12_345.678,
    currentMarketCapUsd: 1_975_308.48,
  });
  assert.match(message, /Current Market Cap: <b>\$1,975,308<\/b>/);
});

test("confirmed buy keyboard contains safe external actions only", () => {
  const config = parseTelegramConfig({});
  const keyboard = confirmedBuyKeyboard({
    signature: "signature-a",
    mint: config.TELEGRAM_ALERT_MINT,
    requestedSol: 0.05,
    finalizedAt: "2026-08-31T12:00:01.000Z",
  }, config);
  assert.deepEqual(keyboard.inline_keyboard.flat().map((button) => button.text), [
    "Buy", "Chart", "Verify", "Website", "Vote CoinSniper", "Vote CoinMooner", "Vote CoinBuzzer", "Vote Coinscope",
    "Rocket DexScreener", "Share",
  ]);
  assert.deepEqual(keyboard.inline_keyboard.flat().map((button) => "url" in button && button.url), [
    config.TELEGRAM_TOKEN_URL,
    `https://dexscreener.com/solana/${config.TELEGRAM_ALERT_MINT}`,
    "https://solscan.io/tx/signature-a",
    config.TELEGRAM_WEBSITE_URL,
    "https://coinsniper.net/coin/93831",
    "https://coinmooner.com/coins/wetzel-wetzel",
    "https://coinbuzzer.me/coin/941",
    "https://www.coinscope.co/coin/wetzel",
    "https://dexscreener.com/solana/DDH9miPnwA4czQbR2jWn8hF1sou755w4scGMfXXk6e6g",
    `https://t.me/share/url?url=${encodeURIComponent(config.TELEGRAM_TOKEN_URL)}`
      + `&text=${encodeURIComponent(`${config.TELEGRAM_PROJECT_NAME} on Solana`)}`,
  ]);
});