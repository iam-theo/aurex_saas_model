export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
export const WORKSPACE_IMAGE = process.env.WORKSPACE_IMAGE ?? "aurex-workspace:latest";
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "opencode/big-pickle";
function parseRunTimeout(): number {
  const raw = process.env.RUN_TIMEOUT_MS;
  if (raw == null || raw === "") return 30 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[config] invalid RUN_TIMEOUT_MS="${raw}" — using default 30m`);
    return 30 * 60 * 1000;
  }
  return n;
}
export const RUN_TIMEOUT_MS = parseRunTimeout();
export const API_URL = process.env.API_URL ?? "http://localhost:4010";
export const INTERNAL_KEY = process.env.AUREX_INTERNAL_KEY ?? "";
if (!INTERNAL_KEY) console.warn("[config] AUREX_INTERNAL_KEY not set — auto-publish disabled");
export const HOST_MODE = process.env.AUREX_HOST_MODE === "true" || process.env.AUREX_EXEC_MODE === "host";
export const HOST_ROOT = process.env.AUREX_HOST_ROOT ?? "/";
if (HOST_MODE) console.log(`[config] HOST MODE enabled — workspaces run directly on host at ${HOST_ROOT}`);
