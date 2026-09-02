import { startTelegramAlerts } from "./telegram-alerts.js";
import { loadTelegramConfig } from "./telegram-config.js";

startTelegramAlerts(loadTelegramConfig()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
