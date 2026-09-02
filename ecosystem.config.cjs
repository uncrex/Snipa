const shared = {
  cwd: __dirname,
  script: "./node_modules/tsx/dist/cli.mjs",
  interpreter: "node",
  instances: 1,
  exec_mode: "fork",
  windowsHide: true,
  autorestart: true,
  restart_delay: 2_000,
  max_restarts: 10,
  min_uptime: "10s",
  time: true,
};

module.exports = {
  apps: [
    {
      ...shared,
      name: "snipa-telegram-mod",
      args: "src/telegram-moderator-entry.ts",
    },
    {
      ...shared,
      name: "snipa-telegram-alerts",
      args: "src/telegram-alerts-entry.ts",
    },
  ],
};