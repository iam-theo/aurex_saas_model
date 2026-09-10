#!/usr/bin/env node
// Watches the aurex source trees and auto-deploys on every change:
//   1. builds the web app, 2. copies it to the nginx webroot,
//   3. restarts the API + worker under PM2.
// Runs under PM2 as "aurex-deploy" (see ecosystem.config.cjs).
import { watch } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const WEBROOT = process.env.AUREX_WEBROOT ? `${process.env.AUREX_WEBROOT.replace(/\/$/, "")}/aurex` : "/var/www/html/aurex";
const WATCH_DIRS = [
  "apps/api/src",
  "apps/worker/src",
  "apps/web/src",
  "packages/shared/src",
  "packages/docker/src",
  "packages/db/prisma",
];

const DEBOUNCE_MS = 1500;
const COOLDOWN_MS = 30_000;
let lastDeployAt = 0;

if (execSync("test -d apps/web && echo ok", { cwd: ROOT }).toString().trim() !== "ok") {
  console.error("[aurex-deploy] cwd does not look like the aurex repo root:", ROOT);
  process.exit(1);
}

let timer = null;
let running = false;
let pending = false;

function shouldDeployNow() {
  // Skip if we just deployed (cooldown prevents thrash from multi-file saves)
  if (Date.now() - lastDeployAt < COOLDOWN_MS && !process.env.AUREX_FORCE_DEPLOY) {
    console.log(`[aurex-deploy] cooldown active (${Math.round((COOLDOWN_MS - (Date.now() - lastDeployAt))/1000)}s left) — coalescing`);
    return false;
  }
  return true;
}

function deploy() {
  if (!shouldDeployNow()) {
    // Reschedule after cooldown
    if (!timer) timer = setTimeout(() => { timer = null; runLoop(); }, COOLDOWN_MS - (Date.now() - lastDeployAt) + 500);
    return;
  }
  const stamp = new Date().toISOString();
  console.log(`[aurex-deploy] change detected @ ${stamp}`);
  try {
    execSync("npm run build --workspace @aurex/web", { cwd: ROOT, stdio: "inherit" });
    execSync(`rm -f ${WEBROOT}/assets/*`, { stdio: "inherit" });
    execSync(
      `cp apps/web/dist/index.html ${WEBROOT}/ && cp -r apps/web/dist/assets ${WEBROOT}/`,
      { cwd: ROOT, stdio: "inherit" },
    );
    execSync("pm2 restart aurex-api aurex-worker --update-env", { stdio: "inherit" });
    lastDeployAt = Date.now();
    console.log(`[aurex-deploy] deployed @ ${new Date().toISOString()}`);
  } catch (e) {
    console.error(`[aurex-deploy] deploy failed: ${e.message}`);
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    runLoop();
  }, DEBOUNCE_MS);
}

function runLoop() {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  try {
    deploy();
  } finally {
    running = false;
    if (pending) {
      pending = false;
      // Don't immediately loop if in cooldown; schedule instead
      if (Date.now() - lastDeployAt < COOLDOWN_MS) schedule();
      else runLoop();
    }
  }
}

for (const dir of WATCH_DIRS) {
  const abs = `${ROOT}/${dir}`;
  watch(abs, { recursive: true }, () => schedule());
  console.log(`[aurex-deploy] watching ${dir}`);
}

process.on("SIGINT", () => {
  console.log("[aurex-deploy] stopping");
  process.exit(0);
});

console.log("[aurex-deploy] listening for source changes");
