import { loadTelegramConfig } from "./telegram-config.js";
import { startTelegramModerator } from "./telegram-moderator.js";

startTelegramModerator(loadTelegramConfig()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
