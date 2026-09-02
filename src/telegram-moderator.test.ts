import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTelegramConfig } from "./telegram-config.js";
import {
  parseCampaignName,
  parseOfficialXPostUrl,
  parsePoll,
  summarizeCampaignJoins,
  telegramChartKeyboard,
  telegramCommunityKeyboard,
  telegramRaidKeyboard,
  telegramRaidMessage,
  telegramVoteKeyboard,
} from "./telegram-moderator.js";

test("chart keyboard contains every verified WETZEL market chart", () => {
  const config = parseTelegramConfig({});
  assert.deepEqual(telegramChartKeyboard(config).inline_keyboard, [[{
    text: "DexScreener",
    url: config.TELEGRAM_DEXSCREENER_URL,
  }, {
    text: "GeckoTerminal",
    url: config.TELEGRAM_GECKOTERMINAL_URL,
  }], [{
    text: "Birdeye",
    url: config.TELEGRAM_BIRDEYE_URL,
  }, {
    text: "DEXTools",
    url: config.TELEGRAM_DEXTOOLS_URL,
  }], [{
    text: "CMC DEXScan",
    url: config.TELEGRAM_CMC_DEXSCAN_URL,
  }]]);
});

test("vote keyboard contains verified URL-only voting actions", () => {
  const config = parseTelegramConfig({});
  const keyboard = telegramVoteKeyboard(config);
  assert.deepEqual(keyboard.inline_keyboard, [[{
    text: "Vote on CoinSniper",
    url: "https://coinsniper.net/coin/93831",
  }], [{
    text: "Vote on CoinMooner",
    url: "https://coinmooner.com/coins/wetzel-wetzel",
  }], [{
    text: "Vote on CoinBuzzer",
    url: "https://coinbuzzer.me/coin/941",
  }], [{
    text: "Vote on Coinscope",
    url: "https://www.coinscope.co/coin/wetzel",
  }], [{
    text: "Rocket on DexScreener",
    url: "https://dexscreener.com/solana/DDH9miPnwA4czQbR2jWn8hF1sou755w4scGMfXXk6e6g",
  }]]);
});

test("official X post parser accepts only normalized WETZEL status URLs", () => {
  const config = parseTelegramConfig({});
  assert.equal(
    parseOfficialXPostUrl("https://x.com/wetzelsol/status/123456789?s=20", config),
    "https://x.com/WetzelSOL/status/123456789",
  );
  assert.equal(parseOfficialXPostUrl("https://x.com/OtherProject/status/123456789", config), undefined);
  assert.equal(parseOfficialXPostUrl("https://example.com/WetzelSOL/status/123456789", config), undefined);
  assert.equal(parseOfficialXPostUrl("https://x.com/WetzelSOL", config), undefined);
});

test("raid keyboard provides voluntary engagement links for the verified post", () => {
  const postUrl = "https://x.com/WetzelSOL/status/123456789";
  assert.deepEqual(telegramRaidKeyboard(postUrl).inline_keyboard, [[{
    text: "Open: Like + Bookmark",
    url: postUrl,
  }], [{
    text: "Repost",
    url: "https://twitter.com/intent/retweet?tweet_id=123456789",
  }, {
    text: "Reply",
    url: "https://twitter.com/intent/tweet?in_reply_to=123456789",
  }]]);
});

test("raid message makes participation optional", () => {
  const message = telegramRaidMessage(parseTelegramConfig({}));
  assert.match(message, /official X post/);
  assert.match(message, /Participation is optional\./);
});

test("community keyboard uses only verified project destinations", () => {
  const config = parseTelegramConfig({});
  assert.deepEqual(telegramCommunityKeyboard(config).inline_keyboard, [[{
    text: "Website",
    url: "https://wetzel.vip/",
  }, {
    text: "Official X",
    url: "https://x.com/WetzelSOL",
  }], [{
    text: "Buy",
    url: config.TELEGRAM_TOKEN_URL,
  }, {
    text: "Chart",
    url: `https://dexscreener.com/solana/${config.TELEGRAM_ALERT_MINT}`,
  }]]);
});

test("campaign names are bounded and safe for Telegram invite labels", () => {
  assert.equal(parseCampaignName(" x-launch_1 "), "x-launch_1");
  assert.equal(parseCampaignName("contains spaces"), undefined);
  assert.equal(parseCampaignName("../private"), undefined);
  assert.equal(parseCampaignName("a".repeat(27)), undefined);
});

test("campaign summaries ignore malformed events and rank join counts", () => {
  const content = [
    JSON.stringify({ campaign: "telegram" }),
    JSON.stringify({ campaign: "x-launch" }),
    "not-json",
    JSON.stringify({ campaign: "telegram" }),
    JSON.stringify({ campaign: "contains spaces" }),
  ].join("\n");
  assert.deepEqual(summarizeCampaignJoins(content), [
    { campaign: "telegram", joins: 2 },
    { campaign: "x-launch", joins: 1 },
  ]);
});

test("poll parser requires a question and two to ten bounded options", () => {
  assert.deepEqual(parsePoll("Favorite update? | Memes | Spaces | Development"), {
    question: "Favorite update?",
    options: ["Memes", "Spaces", "Development"],
  });
  assert.equal(parsePoll("Question | One option"), undefined);
  assert.equal(parsePoll(`Question | Good | ${"x".repeat(101)}`), undefined);
});
