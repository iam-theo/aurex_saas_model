export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
export const API_PORT = Number(process.env.API_PORT ?? 4010);
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "opencode/big-pickle";
export const WORKSPACE_IMAGE = process.env.WORKSPACE_IMAGE ?? "aurex-workspace:latest";
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
export const AUREX_INTERNAL_KEY = process.env.AUREX_INTERNAL_KEY ?? "";
if (!AUREX_INTERNAL_KEY) console.warn("[config] AUREX_INTERNAL_KEY not set — internal publish bypass disabled");
