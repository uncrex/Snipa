import "dotenv/config";
import { z } from "zod";
import { DEFAULT_ALLOWED_PROGRAM_IDS } from "./transaction-policy.js";

const booleanValue = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const enabledBooleanValue = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const optionalPositiveInteger = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce.number().int().positive().max(3_600_000).optional(),
);

const optionalBasisPoints = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce.number().int().min(1).max(9_999).optional(),
);

const optionalNonemptyString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

const environmentSchema = z.object({
  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  SOLANA_KEYPAIR_PATH: optionalNonemptyString,
  SOLANA_PRIVATE_KEY: optionalNonemptyString,
  PUMPPORTAL_API_KEY: optionalNonemptyString,
  LIVE_TRADING: booleanValue,
  LIVE_TRADING_ARM_PATH: z.string().min(1).optional(),
  LIVE_TRADING_ARM_MAX_AGE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  AUTO_BUY: booleanValue,
  BUY_AMOUNT_SOL: z.coerce.number().positive().max(1).default(0.01),
  MAX_BUYS_PER_SESSION: z.coerce.number().int().positive().max(20).default(1),
  MAX_SESSION_BUY_SOL: z.coerce.number().positive().max(5).default(0.05),
  MIN_SOL_RESERVE: z.coerce.number().nonnegative().max(5).default(0.02),
  SLIPPAGE_PERCENT: z.coerce.number().positive().max(25).default(5),
  PRIORITY_FEE_SOL: z.coerce.number().nonnegative().max(0.01).default(0.00005),
  MIN_COMPUTE_HEADROOM_BPS: optionalBasisPoints,
  MAX_TRADE_INTENT_AGE_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
  TOKEN_NAME_REGEX: z.string().optional(),
  TOKEN_SYMBOL_REGEX: z.string().optional(),
  TRADE_JOURNAL_ENABLED: enabledBooleanValue,
  TRADE_JOURNAL_PATH: z.string().min(1).default("./trades.jsonl"),
  SUBMISSION_CONFIRMATION_ALERT_MS: optionalPositiveInteger,
  DASHBOARD_EVENT_LOG_ENABLED: enabledBooleanValue,
  DASHBOARD_EVENT_LOG_PATH: z.string().min(1).default("./dashboard-events.jsonl"),
  DASHBOARD_EVENT_QUEUE_CAPACITY: z.coerce.number().int().positive().max(100_000).default(1_000),
  DASHBOARD_API_HOST: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
  DASHBOARD_API_PORT: z.coerce.number().int().min(1_024).max(65_535).default(8_787),
  DASHBOARD_PROJECTION_STALE_AFTER_MS: z.coerce.number().int().min(5_000).max(3_600_000)
    .default(60_000),
  ALLOWED_PROGRAM_IDS: z.string()
    .default(DEFAULT_ALLOWED_PROGRAM_IDS.join(","))
    .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean))
    .pipe(z.array(z.string()).min(1)),
});

export type Config = z.infer<typeof environmentSchema>;

export function parseConfig(environment: NodeJS.ProcessEnv): Config {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadConfig(): Config {
  return parseConfig(process.env);
}