import "dotenv/config";
import { z } from "zod";

const optionalNonemptyString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

const telegramEnvironmentSchema = z.object({
  SOLANA_RPC_URL: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().url().default("https://api.mainnet-beta.solana.com"),
  ),
  TELEGRAM_MOD_BOT_TOKEN: optionalNonemptyString,
  TELEGRAM_ALERT_BOT_TOKEN: optionalNonemptyString,
  TELEGRAM_GROUP_CHAT_ID: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().regex(/^-\d+$/).optional(),
  ),
  TELEGRAM_MOD_BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]+Bot$/).default("WetzelSOLModBot"),
  TELEGRAM_ALERT_BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]+Bot$/).default("WetzelSOLBot"),
  TELEGRAM_PROJECT_NAME: z.string().min(1).max(64).default("Wetzel"),
  TELEGRAM_WEBSITE_URL: z.string().url().default("https://wetzel.vip/"),
  TELEGRAM_X_URL: z.string().url().default("https://x.com/WetzelSOL"),
  TELEGRAM_TOKEN_URL: z.string().url()
    .default("https://pump.fun/coin/FYwxAEKhksrMFeUgxwRE99Jn3BcdzK3Y1JPUbkf3pump"),
  TELEGRAM_COINSNIPER_URL: z.string().url().regex(/^https:\/\/coinsniper\.net\/coin\/\d+\/?$/)
    .default("https://coinsniper.net/coin/93831"),
  TELEGRAM_COINMOONER_URL: z.string().url()
    .regex(/^https:\/\/coinmooner\.com\/coins\/[a-z0-9-]+\/?$/)
    .default("https://coinmooner.com/coins/wetzel-wetzel"),
  TELEGRAM_COINBUZZER_URL: z.string().url().regex(/^https:\/\/coinbuzzer\.me\/coin\/\d+\/?$/)
    .default("https://coinbuzzer.me/coin/941"),
  TELEGRAM_COINSCOPE_URL: z.string().url()
    .regex(/^https:\/\/www\.coinscope\.co\/coin\/[a-z0-9-]+\/?$/)
    .default("https://www.coinscope.co/coin/wetzel"),
  TELEGRAM_DEXSCREENER_URL: z.string().url()
    .regex(/^https:\/\/dexscreener\.com\/solana\/[A-Za-z0-9]+\/?$/)
    .default("https://dexscreener.com/solana/DDH9miPnwA4czQbR2jWn8hF1sou755w4scGMfXXk6e6g"),
  TELEGRAM_GECKOTERMINAL_URL: z.string().url()
    .regex(/^https:\/\/www\.geckoterminal\.com\/solana\/pools\/[A-Za-z0-9]+\/?$/)
    .default("https://www.geckoterminal.com/solana/pools/DDH9miPnwA4czQbR2jWn8hF1sou755w4scGMfXXk6e6g"),
  TELEGRAM_BIRDEYE_URL: z.string().url()
    .regex(/^https:\/\/birdeye\.so\/solana\/token\/[A-Za-z0-9]+\/?$/)
    .default("https://birdeye.so/solana/token/FYwxAEKhksrMFeUgxwRE99Jn3BcdzK3Y1JPUbkf3pump"),
  TELEGRAM_DEXTOOLS_URL: z.string().url()
    .regex(/^https:\/\/www\.dextools\.io\/app\/en\/solana\/pair-explorer\/[A-Za-z0-9]+\/?$/)
    .default("https://www.dextools.io/app/en/solana/pair-explorer/FYwxAEKhksrMFeUgxwRE99Jn3BcdzK3Y1JPUbkf3pump"),
  TELEGRAM_CMC_DEXSCAN_URL: z.string().url()
    .regex(/^https:\/\/dex\.coinmarketcap\.com\/solana\/[A-Za-z0-9]+\/?$/)
    .default("https://dex.coinmarketcap.com/solana/DDH9miPnwA4czQbR2jWn8hF1sou755w4scGMfXXk6e6g/"),
  TELEGRAM_ALERT_MINT: z.string().min(32).max(44)
    .default("FYwxAEKhksrMFeUgxwRE99Jn3BcdzK3Y1JPUbkf3pump"),
  TELEGRAM_BUY_ALERT_MIN_SOL: z.coerce.number().positive().max(100).default(0.01),
  TELEGRAM_PUBLIC_BUY_LOOKBACK_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),
  TELEGRAM_ALERT_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),
  TELEGRAM_ALERT_ANIMATION_PATH: z.string().min(1).default("./assets/WETZEL-Buy-Alert.mp4"),
  TELEGRAM_ALERT_SENT_LOG_PATH: z.string().min(1).default("./telegram-alerts-sent.jsonl"),
  TRADE_JOURNAL_PATH: z.string().min(1).default("./trades.jsonl"),
  TELEGRAM_NEW_MEMBER_RESTRICTION_SECONDS: z.coerce.number().int().min(60).max(86_400)
    .default(600),
  TELEGRAM_INCIDENT_LOG_PATH: z.string().min(1).default("./telegram-incidents.jsonl"),
  TELEGRAM_CAMPAIGN_LOG_PATH: z.string().min(1).default("./telegram-campaigns.jsonl"),
});

export type TelegramConfig = z.infer<typeof telegramEnvironmentSchema>;

export function parseTelegramConfig(environment: NodeJS.ProcessEnv): TelegramConfig {
  const result = telegramEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid Telegram configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadTelegramConfig(): TelegramConfig {
  return parseTelegramConfig(process.env);
}