import type { TelegramConfig } from "./telegram-config.js";

export function escapeTelegramHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function telegramLinks(config: TelegramConfig): string {
  return [
    `<b>${escapeTelegramHtml(config.TELEGRAM_PROJECT_NAME)} official links</b>`,
    `<a href="${config.TELEGRAM_WEBSITE_URL}">Website</a>`,
    `<a href="${config.TELEGRAM_X_URL}">X / Twitter</a>`,
    `<a href="${config.TELEGRAM_TOKEN_URL}">Pump.fun token page</a>`,
    `<code>${escapeTelegramHtml(config.TELEGRAM_ALERT_MINT)}</code>`,
  ].join("\n");
}

export function telegramAbout(config: TelegramConfig): string {
  return [
    `<b>About ${escapeTelegramHtml(config.TELEGRAM_PROJECT_NAME)}</b>`,
    "WETZEL is a community token on Solana launched through Pump.fun.",
    `Contract: <code>${escapeTelegramHtml(config.TELEGRAM_ALERT_MINT)}</code>`,
    "Use /links for verified destinations, /chart for market data, and /buy for the official token page.",
    "Cryptoassets are volatile. Verify every address and never risk funds you cannot afford to lose.",
  ].join("\n");
}

export function telegramFaq(config: TelegramConfig): string {
  return [
    `<b>${escapeTelegramHtml(config.TELEGRAM_PROJECT_NAME)} FAQ</b>`,
    "<b>Where is the contract?</b>",
    `<code>${escapeTelegramHtml(config.TELEGRAM_ALERT_MINT)}</code>`,
    "<b>Where can I verify links?</b>",
    "Use /links. Do not trust contract addresses or links sent by strangers.",
    "<b>How do buy alerts work?</b>",
    "The alert bot verifies qualifying confirmed on-chain buys for the official mint.",
    "<b>Will admins DM me first?</b>",
    "No. Admins will never request seed phrases, private keys, tokens, or wallet connections.",
    "<b>How do I report suspicious content?</b>",
    "Reply to the message with /report. The bot records only Telegram IDs and timestamps.",
  ].join("\n");
}

export function telegramCommunityPanel(config: TelegramConfig): string {
  return [
    `<b>Welcome to ${escapeTelegramHtml(config.TELEGRAM_PROJECT_NAME)}</b>`,
    "Verify first. Participate at your own pace.",
    `Contract: <code>${escapeTelegramHtml(config.TELEGRAM_ALERT_MINT)}</code>`,
    "Start with /about, /links, /chart, /vote, and /faq.",
    "Admins will never DM first or request wallet secrets.",
  ].join("\n");
}

export function telegramRules(config: TelegramConfig): string {
  return [
    `<b>${escapeTelegramHtml(config.TELEGRAM_PROJECT_NAME)} community rules</b>`,
    "1. Be respectful and keep discussion relevant.",
    "2. No spam, unsolicited promotions, or repeated messages.",
    "3. Never share seed phrases, private keys, or bot tokens.",
    "4. Admins will never DM first or ask you to connect a wallet.",
    "5. Verify every link with /links before opening it.",
    "6. No market manipulation, fake engagement, or misleading claims.",
  ].join("\n");
}

export function telegramWelcome(config: TelegramConfig, displayName: string): string {
  return [
    `Welcome to <b>${escapeTelegramHtml(config.TELEGRAM_PROJECT_NAME)}</b>, ${escapeTelegramHtml(displayName)}.`,
    "WETZEL is a community token on Solana launched through Pump.fun.",
    `Contract: <code>${escapeTelegramHtml(config.TELEGRAM_ALERT_MINT)}</code>`,
    "Research the project and market before deciding whether to participate. Cryptoassets are volatile.",
    "Use the verified buttons below. Admins never DM first or request wallet secrets.",
    "New-member links and media unlock automatically after the brief safety period.",
  ].join("\n");
}