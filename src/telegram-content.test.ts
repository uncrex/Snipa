import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTelegramConfig } from "./telegram-config.js";
import {
  escapeTelegramHtml,
  telegramAbout,
  telegramCommunityPanel,
  telegramFaq,
  telegramLinks,
  telegramRules,
  telegramWelcome,
} from "./telegram-content.js";

test("Telegram content escapes member-controlled HTML and uses verified links", () => {
  const config = parseTelegramConfig({});
  assert.equal(escapeTelegramHtml("<A&B>"), "&lt;A&amp;B&gt;");
  assert.match(telegramWelcome(config, "<script>"), /&lt;script&gt;/);
  assert.doesNotMatch(telegramWelcome(config, "<script>"), /<script>/);
  assert.match(telegramWelcome(config, "New member"), /Research the project and market/);
  assert.match(telegramWelcome(config, "New member"), /Cryptoassets are volatile/);
  assert.match(telegramWelcome(config, "New member"), new RegExp(config.TELEGRAM_ALERT_MINT));
  assert.match(telegramLinks(config), /https:\/\/wetzel\.vip\//);
  assert.match(telegramLinks(config), new RegExp(config.TELEGRAM_ALERT_MINT));
  assert.match(telegramRules(config), /Never share seed phrases/);
  assert.match(telegramRules(config), /No market manipulation/);
  assert.match(telegramAbout(config), new RegExp(config.TELEGRAM_ALERT_MINT));
  assert.match(telegramFaq(config), /reply to the message with \/report/i);
  assert.match(telegramCommunityPanel(config), /\/about, \/links, \/chart, \/vote, and \/faq/);
});