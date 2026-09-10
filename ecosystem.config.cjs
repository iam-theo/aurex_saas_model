// Aurex PM2 ecosystem config — portable (no hardcoded user/home paths)
// Start all:  pm2 start ecosystem.config.cjs
// Stop all:   pm2 stop aurex-api aurex-worker aurex-web
const path = require("path");
const os = require("os");

const ROOT = __dirname;
const HOME = os.homedir();
const HOME_BIN = [
  path.join(HOME, ".npm-global/bin"),
  path.join(HOME, ".bun/bin"),
  path.join(HOME, ".local/bin"),
].join(":");
const BASE_PATH = `${HOME_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${process.env.PATH || ""}`;

module.exports = {
  apps: [
    {
      name: "aurex-api",
      cwd: path.join(ROOT, "apps/api"),
      script: path.join(ROOT, "node_modules/.bin/tsx"),
      args: "--env-file=../../.env src/index.ts",
      interpreter: "none",
      env: {
        NODE_ENV: "production",
        PATH: BASE_PATH,
      },
    },
    {
      name: "aurex-worker",
      cwd: path.join(ROOT, "apps/worker"),
      script: path.join(ROOT, "node_modules/.bin/tsx"),
      args: "--env-file=../../.env src/index.ts",
      interpreter: "none",
      env: {
        NODE_ENV: "production",
        PATH: BASE_PATH,
        OPENCODE_BIN: path.join(HOME, ".npm-global/bin/opencode"),
      },
    },
    {
      name: "aurex-web",
      cwd: path.join(ROOT, "apps/web"),
      script: path.join(ROOT, "node_modules/.bin/vite"),
      args: "--host",
      interpreter: "none",
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "aurex-deploy",
      cwd: ROOT,
      script: path.join(ROOT, "scripts/deploy-watch.mjs"),
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
