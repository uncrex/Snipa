import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Bot, GrammyError, HttpError, InlineKeyboard, type Context } from "grammy";
import type { TelegramConfig } from "./telegram-config.js";
import {
  escapeTelegramHtml,
  telegramAbout,
  telegramCommunityPanel,
  telegramFaq,
  telegramLinks,
  telegramRules,
  telegramWelcome,
} from "./telegram-content.js";

interface ModerationIncident {
  timestamp: string;
  action: "delete-forward" | "flood-restrict" | "new-member-restrict" | "user-report";
  chatId: number;
  userId: number;
  messageId?: number;
  targetMessageId?: number;
  until?: string;
}

interface CampaignJoin {
  timestamp: string;
  campaign: string;
  chatId: number;
  updateId: number;
}

const floodWindows = new Map<string, number[]>();
const FLOOD_WINDOW_MS = 10_000;
const FLOOD_MESSAGE_LIMIT = 6;
const FLOOD_RESTRICTION_SECONDS = 60;

export function parseCampaignName(value: string): string | undefined {
  const campaign = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,25}$/.test(campaign) ? campaign : undefined;
}

export function parsePoll(value: string): { question: string; options: string[] } | undefined {
  const [question = "", ...options] = value.split("|").map((part) => part.trim());
  if (
    question.length < 1
    || question.length > 300
    || options.length < 2
    || options.length > 10
    || options.some((option) => option.length < 1 || option.length > 100)
  ) return undefined;
  return { question, options };
}

export function summarizeCampaignJoins(content: string): Array<{ campaign: string; joins: number }> {
  const totals = new Map<string, number>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { campaign?: unknown };
      if (typeof event.campaign !== "string" || !parseCampaignName(event.campaign)) continue;
      totals.set(event.campaign, (totals.get(event.campaign) ?? 0) + 1);
    } catch {
      continue;
    }
  }
  return [...totals.entries()]
    .map(([campaign, joins]) => ({ campaign, joins }))
    .sort((left, right) => right.joins - left.joins || left.campaign.localeCompare(right.campaign));
}

export function parseOfficialXPostUrl(value: string, config: TelegramConfig): string | undefined {
  try {
    const profileUrl = new URL(config.TELEGRAM_X_URL);
    const postUrl = new URL(value.trim());
    const profileName = profileUrl.pathname.split("/").filter(Boolean)[0];
    const path = postUrl.pathname.split("/").filter(Boolean);
    if (
      profileUrl.hostname.toLowerCase() !== "x.com"
      || postUrl.protocol !== "https:"
      || postUrl.hostname.toLowerCase() !== "x.com"
      || !profileName
      || path.length !== 3
      || path[0]?.toLowerCase() !== profileName.toLowerCase()
      || path[1] !== "status"
      || !/^\d+$/.test(path[2] ?? "")
    ) return undefined;
    return `https://x.com/${profileName}/status/${path[2]}`;
  } catch {
    return undefined;
  }
}

export function telegramRaidKeyboard(postUrl: string): InlineKeyboard {
  const tweetId = new URL(postUrl).pathname.split("/").at(-1)!;
  return new InlineKeyboard()
    .url("Open: Like + Bookmark", postUrl)
    .row()
    .url("Repost", `https://twitter.com/intent/retweet?tweet_id=${tweetId}`)
    .url("Reply", `https://twitter.com/intent/tweet?in_reply_to=${tweetId}`);
}

export function telegramRaidMessage(config: TelegramConfig): string {
  return [
    `<b>${escapeTelegramHtml(config.TELEGRAM_PROJECT_NAME)} community raid</b>`,
    "Open the official X post and engage only if you genuinely want to.",
    "Like, repost, bookmark, or leave a relevant reply. Participation is optional.",
  ].join("\n");
}

export function telegramCommunityKeyboard(config: TelegramConfig): InlineKeyboard {
  const chartUrl = `https://dexscreener.com/solana/${encodeURIComponent(config.TELEGRAM_ALERT_MINT)}`;
  return new InlineKeyboard()
    .url("Website", config.TELEGRAM_WEBSITE_URL)
    .url("Official X", config.TELEGRAM_X_URL)
    .row()
    .url("Buy", config.TELEGRAM_TOKEN_URL)
    .url("Chart", chartUrl);
}

export function telegramVoteKeyboard(config: TelegramConfig): InlineKeyboard {
  return new InlineKeyboard()
    .url("Vote on CoinSniper", config.TELEGRAM_COINSNIPER_URL)
    .row()
    .url("Vote on CoinMooner", config.TELEGRAM_COINMOONER_URL)
    .row()
    .url("Vote on CoinBuzzer", config.TELEGRAM_COINBUZZER_URL)
    .row()
    .url("Vote on Coinscope", config.TELEGRAM_COINSCOPE_URL)
    .row()
    .url("Rocket on DexScreener", config.TELEGRAM_DEXSCREENER_URL);
}

export function telegramChartKeyboard(config: TelegramConfig): InlineKeyboard {
  return new InlineKeyboard()
    .url("DexScreener", config.TELEGRAM_DEXSCREENER_URL)
    .url("GeckoTerminal", config.TELEGRAM_GECKOTERMINAL_URL)
    .row()
    .url("Birdeye", config.TELEGRAM_BIRDEYE_URL)
    .url("DEXTools", config.TELEGRAM_DEXTOOLS_URL)
    .row()
    .url("CMC DEXScan", config.TELEGRAM_CMC_DEXSCAN_URL);
}

async function appendIncident(path: string, incident: ModerationIncident): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(incident)}\n`, "utf8");
}

async function isChatAdmin(context: Context): Promise<boolean> {
  if (!context.chat || !context.from) return false;
  const member = await context.api.getChatMember(context.chat.id, context.from.id);
  return member.status === "administrator" || member.status === "creator";
}

function isConfiguredGroup(context: Context, config: TelegramConfig): boolean {
  return context.chat?.type === "group" || context.chat?.type === "supergroup"
    ? config.TELEGRAM_GROUP_CHAT_ID === undefined
      || context.chat.id.toString() === config.TELEGRAM_GROUP_CHAT_ID
    : false;
}

async function restrictNewMember(context: Context, config: TelegramConfig, userId: number): Promise<void> {
  if (!context.chat) return;
  const untilDate = Math.floor(Date.now() / 1_000) + config.TELEGRAM_NEW_MEMBER_RESTRICTION_SECONDS;
  await context.api.restrictChatMember(context.chat.id, userId, {
      can_send_messages: true,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
      can_manage_topics: false,
  }, {
    use_independent_chat_permissions: true,
    until_date: untilDate,
  });
  await appendIncident(config.TELEGRAM_INCIDENT_LOG_PATH, {
    timestamp: new Date().toISOString(),
    action: "new-member-restrict",
    chatId: context.chat.id,
    userId,
    until: new Date(untilDate * 1_000).toISOString(),
  });
}

async function handleFlood(context: Context, config: TelegramConfig): Promise<boolean> {
  if (!context.chat || !context.from || context.from.is_bot || await isChatAdmin(context)) return false;
  const now = Date.now();
  const key = `${context.chat.id}:${context.from.id}`;
  const recent = (floodWindows.get(key) ?? []).filter((timestamp) => now - timestamp <= FLOOD_WINDOW_MS);
  recent.push(now);
  floodWindows.set(key, recent);
  if (recent.length <= FLOOD_MESSAGE_LIMIT) return false;
  floodWindows.delete(key);
  const untilDate = Math.floor(now / 1_000) + FLOOD_RESTRICTION_SECONDS;
  await context.api.restrictChatMember(context.chat.id, context.from.id, {
    can_send_messages: false,
  }, {
    until_date: untilDate,
  });
  if (context.message) await context.deleteMessage();
  await appendIncident(config.TELEGRAM_INCIDENT_LOG_PATH, {
    timestamp: new Date(now).toISOString(),
    action: "flood-restrict",
    chatId: context.chat.id,
    userId: context.from.id,
    messageId: context.message?.message_id,
    until: new Date(untilDate * 1_000).toISOString(),
  });
  return true;
}

export async function startTelegramModerator(config: TelegramConfig): Promise<void> {
  if (!config.TELEGRAM_MOD_BOT_TOKEN) {
    throw new Error("TELEGRAM_MOD_BOT_TOKEN is required for telegram-mod.");
  }
  const bot = new Bot(config.TELEGRAM_MOD_BOT_TOKEN);
  bot.command("chatid", async (context) => {
    if (!isConfiguredGroup(context, config) || !await isChatAdmin(context)) return;
    await context.reply(`Telegram group chat ID: <code>${context.chat.id}</code>`, {
      parse_mode: "HTML",
      reply_parameters: { message_id: context.message!.message_id },
    });
  });
  bot.command("rules", async (context) => {
    if (!isConfiguredGroup(context, config)) return;
    await context.reply(telegramRules(config), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
  bot.command("links", async (context) => {
    if (!isConfiguredGroup(context, config)) return;
    await context.reply(telegramLinks(config), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
  bot.command("about", async (context) => {
    if (!isConfiguredGroup(context, config)) return;
    await context.reply(telegramAbout(config), {
      parse_mode: "HTML",
      reply_markup: telegramCommunityKeyboard(config),
      link_preview_options: { is_disabled: true },
    });
  });
  bot.command("buy", async (context) => {
    if (!isConfiguredGroup(context, config)) return;
    await context.reply(`<b>Official ${escapeTelegramHtml(config.TELEGRAM_PROJECT_NAME)} token page</b>`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().url("Open Pump.fun", config.TELEGRAM_TOKEN_URL),
    });
  });
  bot.command("chart", async (context) => {
    if (!isConfiguredGroup(context, config)) return;
    await context.reply(`<b>${escapeTelegramHtml(config.TELEGRAM_PROJECT_NAME)} market charts</b>`, {
      parse_mode: "HTML",
      reply_markup: telegramChartKeyboard(config),
    });
  });
  bot.command("faq", async (context) => {
    if (!isConfiguredGroup(context, config)) return;
    await context.reply(telegramFaq(config), { parse_mode: "HTML" });
  });
  bot.command("report", async (context) => {
    if (!isConfiguredGroup(context, config)) return;
    const targetMessage = context.message?.reply_to_message;
    if (!targetMessage) {
      await context.reply("Reply to a suspicious message with /report so admins can review it.", {
        reply_parameters: { message_id: context.message!.message_id },
      });
      return;
    }
    await appendIncident(config.TELEGRAM_INCIDENT_LOG_PATH, {
      timestamp: new Date().toISOString(),
      action: "user-report",
      chatId: context.chat.id,
      userId: context.from!.id,
      messageId: context.message!.message_id,
      targetMessageId: targetMessage.message_id,
    });
    await context.reply("<b>Report received.</b> Admins, please review this message.", {
      parse_mode: "HTML",
      reply_parameters: { message_id: targetMessage.message_id },
    });
  });
  bot.command("vote", async (context) => {
    if (!isConfiguredGroup(context, config)) return;
    await context.reply(`<b>Vote for ${escapeTelegramHtml(config.TELEGRAM_PROJECT_NAME)}</b>`, {
      parse_mode: "HTML",
      reply_markup: telegramVoteKeyboard(config),
    });
  });
  bot.command("raid", async (context) => {
    if (!isConfiguredGroup(context, config) || !await isChatAdmin(context)) return;
    const postUrl = parseOfficialXPostUrl(context.match, config);
    if (!postUrl) {
      await context.reply(
        `Usage: <code>/raid https://x.com/WetzelSOL/status/...</code>`,
        { parse_mode: "HTML", reply_parameters: { message_id: context.message!.message_id } },
      );
      return;
    }
    await context.reply(telegramRaidMessage(config), {
      parse_mode: "HTML",
      reply_markup: telegramRaidKeyboard(postUrl),
      link_preview_options: { is_disabled: true },
    });
  });
  bot.command("pinwelcome", async (context) => {
    if (!isConfiguredGroup(context, config) || !await isChatAdmin(context)) return;
    const message = await context.reply(telegramCommunityPanel(config), {
      parse_mode: "HTML",
      reply_markup: telegramCommunityKeyboard(config),
      link_preview_options: { is_disabled: true },
    });
    await context.api.pinChatMessage(context.chat.id, message.message_id, { disable_notification: true });
  });
  bot.command("invite", async (context) => {
    if (!isConfiguredGroup(context, config) || !await isChatAdmin(context)) return;
    const campaign = parseCampaignName(context.match);
    if (!campaign) {
      await context.reply("Usage: /invite campaign-name (letters, numbers, hyphens, and underscores only)", {
        reply_parameters: { message_id: context.message!.message_id },
      });
      return;
    }
    const invite = await context.createChatInviteLink({ name: `snipa:${campaign}` });
    await context.reply(`<b>${escapeTelegramHtml(campaign)} campaign invite</b>`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().url("Open or share invite", invite.invite_link),
    });
  });
  bot.command("campaigns", async (context) => {
    if (!isConfiguredGroup(context, config) || !await isChatAdmin(context)) return;
    const campaigns = summarizeCampaignJoins(await readOptional(config.TELEGRAM_CAMPAIGN_LOG_PATH));
    const lines = campaigns.length === 0
      ? ["No campaign joins recorded yet."]
      : campaigns.map(({ campaign, joins }) => `${escapeTelegramHtml(campaign)}: <b>${joins}</b>`);
    await context.reply(["<b>Campaign joins</b>", ...lines].join("\n"), { parse_mode: "HTML" });
  });
  bot.command("poll", async (context) => {
    if (!isConfiguredGroup(context, config) || !await isChatAdmin(context)) return;
    const poll = parsePoll(context.match);
    if (!poll) {
      await context.reply("Usage: /poll Question | Option 1 | Option 2", {
        reply_parameters: { message_id: context.message!.message_id },
      });
      return;
    }
    await context.replyWithPoll(poll.question, poll.options, { is_anonymous: true });
  });
  bot.on("chat_member", async (context) => {
    if (!isConfiguredGroup(context, config)) return;
    const update = context.chatMember;
    const oldStatus = update.old_chat_member.status;
    const newStatus = update.new_chat_member.status;
    const joined = (oldStatus === "left" || oldStatus === "kicked")
      && newStatus !== "left"
      && newStatus !== "kicked";
    const inviteName = update.invite_link?.name;
    if (!joined || update.new_chat_member.user.is_bot || !inviteName?.startsWith("snipa:")) return;
    const campaign = parseCampaignName(inviteName.slice("snipa:".length));
    if (!campaign) return;
    await appendCampaignJoin(config.TELEGRAM_CAMPAIGN_LOG_PATH, {
      timestamp: new Date().toISOString(),
      campaign,
      chatId: update.chat.id,
      updateId: context.update.update_id,
    });
  });
  bot.on("message:new_chat_members", async (context) => {
    if (!isConfiguredGroup(context, config)) return;
    for (const member of context.message.new_chat_members) {
      if (!member.is_bot) await restrictNewMember(context, config, member.id);
    }
    const names = context.message.new_chat_members
      .filter((member) => !member.is_bot)
      .map((member) => member.first_name)
      .join(", ");
    if (names) await context.reply(telegramWelcome(config, names), {
      parse_mode: "HTML",
      reply_markup: telegramCommunityKeyboard(config),
      link_preview_options: { is_disabled: true },
    });
  });
  bot.on("message", async (context) => {
    if (!isConfiguredGroup(context, config) || context.message.new_chat_members) return;
    if (await handleFlood(context, config)) return;
    if (context.message.forward_origin && !await isChatAdmin(context)) {
      await context.deleteMessage();
      await appendIncident(config.TELEGRAM_INCIDENT_LOG_PATH, {
        timestamp: new Date().toISOString(),
        action: "delete-forward",
        chatId: context.chat.id,
        userId: context.from.id,
        messageId: context.message.message_id,
      });
    }
  });
  bot.catch(({ error }) => {
    if (error instanceof GrammyError) console.error(`Telegram API error: ${error.description}`);
    else if (error instanceof HttpError) console.error(`Telegram network error: ${error.message}`);
    else console.error(`Telegram moderator error: ${error instanceof Error ? error.message : error}`);
  });
  await bot.api.setMyCommands([
    { command: "rules", description: "Show community rules" },
    { command: "links", description: "Show verified official links" },
    { command: "about", description: "About WETZEL and key destinations" },
    { command: "buy", description: "Open the official Pump.fun page" },
    { command: "chart", description: "Open the verified market chart" },
    { command: "faq", description: "Show safety and project FAQ" },
    { command: "report", description: "Report a replied-to message" },
    { command: "vote", description: "Show verified voting links" },
    { command: "raid", description: "Start an official X raid (admins only)" },
    { command: "pinwelcome", description: "Post and pin welcome panel (admins only)" },
    { command: "invite", description: "Create a tracked invite (admins only)" },
    { command: "campaigns", description: "Show campaign join counts (admins only)" },
    { command: "poll", description: "Start a community poll (admins only)" },
    { command: "chatid", description: "Show this group ID (admins only)" },
  ]);
  await bot.start({
    allowed_updates: ["message", "chat_member"],
    onStart: () => console.log(`@${config.TELEGRAM_MOD_BOT_USERNAME} is running.`),
  });
}

async function appendCampaignJoin(path: string, event: CampaignJoin): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}