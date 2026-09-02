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
      name: "snipa-monitor",
      args: "src/index.ts monitor",
    },
    {
      ...shared,
      name: "snipa-dashboard-api",
      args: "src/index.ts dashboard-api",
    },
  ],
};
