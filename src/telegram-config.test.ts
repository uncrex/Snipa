import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTelegramConfig } from "./telegram-config.js";

test("Telegram defaults are public-only and credentials remain optional", () => {
  const config = parseTelegramConfig({});
  assert.equal(config.TELEGRAM_MOD_BOT_TOKEN, undefined);
  assert.equal(config.TELEGRAM_ALERT_BOT_TOKEN, undefined);
  assert.equal(config.TELEGRAM_GROUP_CHAT_ID, undefined);
  assert.equal(config.TELEGRAM_MOD_BOT_USERNAME, "WetzelSOLModBot");
  assert.equal(config.TELEGRAM_ALERT_BOT_USERNAME, "WetzelSOLBot");
  assert.equal(config.TELEGRAM_BUY_ALERT_MIN_SOL, 0.01);
  assert.equal(config.TELEGRAM_PUBLIC_BUY_LOOKBACK_SECONDS, 3_600);
  assert.equal(config.TELEGRAM_COINSNIPER_URL, "https://coinsniper.net/coin/93831");
  assert.equal(config.TELEGRAM_COINMOONER_URL, "https://coinmooner.com/coins/wetzel-wetzel");
  assert.equal(config.TELEGRAM_COINBUZZER_URL, "https://coinbuzzer.me/coin/941");
  assert.equal(config.TELEGRAM_COINSCOPE_URL, "https://www.coinscope.co/coin/wetzel");
  assert.equal(
    config.TELEGRAM_DEXSCREENER_URL,
    "https://dexscreener.com/solana/DDH9miPnwA4czQbR2jWn8hF1sou755w4scGMfXXk6e6g",
  );
  assert.equal(
    config.TELEGRAM_GECKOTERMINAL_URL,
    "https://www.geckoterminal.com/solana/pools/DDH9miPnwA4czQbR2jWn8hF1sou755w4scGMfXXk6e6g",
  );
  assert.equal(config.TELEGRAM_BIRDEYE_URL, `https://birdeye.so/solana/token/${config.TELEGRAM_ALERT_MINT}`);
  assert.equal(
    config.TELEGRAM_DEXTOOLS_URL,
    `https://www.dextools.io/app/en/solana/pair-explorer/${config.TELEGRAM_ALERT_MINT}`,
  );
  assert.equal(
    config.TELEGRAM_CMC_DEXSCAN_URL,
    "https://dex.coinmarketcap.com/solana/DDH9miPnwA4czQbR2jWn8hF1sou755w4scGMfXXk6e6g/",
  );
  assert.equal(config.TELEGRAM_ALERT_ANIMATION_PATH, "./assets/WETZEL-Buy-Alert.mp4");
  assert.equal(config.TELEGRAM_NEW_MEMBER_RESTRICTION_SECONDS, 600);
  assert.equal(config.TELEGRAM_CAMPAIGN_LOG_PATH, "./telegram-campaigns.jsonl");
});

test("Telegram settings reject invalid chat IDs and moderation windows", () => {
  assert.equal(parseTelegramConfig({ TELEGRAM_GROUP_CHAT_ID: "-1001234567890" })
    .TELEGRAM_GROUP_CHAT_ID, "-1001234567890");
  assert.throws(
    () => parseTelegramConfig({ TELEGRAM_GROUP_CHAT_ID: "public-name" }),
    /Invalid Telegram configuration/,
  );
  assert.throws(
    () => parseTelegramConfig({ TELEGRAM_NEW_MEMBER_RESTRICTION_SECONDS: "59" }),
    /Invalid Telegram configuration/,
  );
  assert.throws(
    () => parseTelegramConfig({ TELEGRAM_COINSNIPER_URL: "https://example.com/coin/93831" }),
    /Invalid Telegram configuration/,
  );
  assert.throws(
    () => parseTelegramConfig({ TELEGRAM_COINMOONER_URL: "https://example.com/coins/wetzel-wetzel" }),
    /Invalid Telegram configuration/,
  );
  assert.throws(
    () => parseTelegramConfig({ TELEGRAM_COINBUZZER_URL: "https://example.com/coin/941" }),
    /Invalid Telegram configuration/,
  );
  assert.throws(
    () => parseTelegramConfig({ TELEGRAM_COINSCOPE_URL: "https://example.com/coin/wetzel" }),
    /Invalid Telegram configuration/,
  );
  assert.throws(
    () => parseTelegramConfig({ TELEGRAM_DEXSCREENER_URL: "https://example.com/solana/pair" }),
    /Invalid Telegram configuration/,
  );
  for (const [name, value] of Object.entries({
    TELEGRAM_GECKOTERMINAL_URL: "https://example.com/solana/pools/pair",
    TELEGRAM_BIRDEYE_URL: "https://example.com/solana/token/mint",
    TELEGRAM_DEXTOOLS_URL: "https://example.com/app/en/solana/pair-explorer/mint",
    TELEGRAM_CMC_DEXSCAN_URL: "https://example.com/solana/pair",
  })) {
    assert.throws(() => parseTelegramConfig({ [name]: value }), /Invalid Telegram configuration/);
  }
});