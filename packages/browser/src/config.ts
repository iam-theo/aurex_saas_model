/**
 * Configuration for the Aurex browser subsystem.
 *
 * All values have sensible defaults and can be overridden at construction time
 * (e.g. from an opencode config block like `{ "browser": { ... } }`) or from
 * environment variables prefixed with AUREX_BROWSER_. Nothing here hardcodes a
 * specific port, host or application — those are discovered or configured.
 */

export interface BrowserConfig {
  /** Master on/off switch. False disables all browser tooling. */
  enabled: boolean;
  /** Maximum milliseconds to wait for a single navigation. */
  navigationTimeoutMs: number;
  /** Default timeout for element actions (click/fill/etc). */
  actionTimeoutMs: number;
  /** Maximum time to wait for an application to become ready. */
  readinessTimeoutMs: number;
  /** Browser viewport width used as the default. */
  viewportWidth: number;
  /** Browser viewport height used as the default. */
  viewportHeight: number;
  /** Path to a Chromium binary. Empty = let Playwright discover it. */
  executablePath: string | null;
  /** Playwright "channel" to use (e.g. "chrome" for system Google Chrome). */
  channel: string | null;
  /** Headless mode. */
  headless: boolean;
  /**
   * Map of host -> protocol/port that the browser is allowed to reach.
   * Keys are hostnames; a value of "*" allows any port on that host.
   * If this list is non-empty, navigation outside the allowed hosts is blocked.
   */
  allowedHosts: Record<string, string>;
  /** When true, console/network output is sanitized for secrets. */
  sanitizeOutput: boolean;
  /** Directory screenshot/artifact files are written to ("" = in-memory only). */
  outputDir: string | null;
  /** Maximum number of repair iterations for browser QA. */
  maxIterations: number;
  /** Comma-separated regexes of request URLs never surfaced to the agent. */
  blockedUrlPatterns: string[];
}

function num(v: string | undefined, dflt: number): number {
  if (v == null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v == null || v === "") return dflt;
  return v === "true" || v === "1" || v === "yes";
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  enabled: true,
  navigationTimeoutMs: 30_000,
  actionTimeoutMs: 10_000,
  readinessTimeoutMs: 60_000,
  viewportWidth: 1440,
  viewportHeight: 900,
  executablePath: process.env.AUREX_BROWSER_EXECUTABLE_PATH ?? null,
  channel: process.env.AUREX_BROWSER_CHANNEL ?? null,
  headless: bool(process.env.AUREX_BROWSER_HEADLESS, true),
  allowedHosts: parseAllowedHosts(process.env.AUREX_BROWSER_ALLOWED_HOSTS),
  sanitizeOutput: bool(process.env.AUREX_BROWSER_SANITIZE, true),
  outputDir: process.env.AUREX_BROWSER_OUTPUT_DIR ?? null,
  maxIterations: num(process.env.AUREX_BROWSER_MAX_ITERATIONS, 5),
  blockedUrlPatterns: ["/secrets/", "/credentials/", "kubernetes.default.svc", "metadata.google.internal"],
};

function parseAllowedHosts(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const idx = p.indexOf(":");
    if (idx === -1) out[p] = "*";
    else out[p.slice(0, idx)] = p.slice(idx + 1);
  }
  return out;
}

/**
 * Merge partial overrides (from code/config) into the defaults. Unknown keys
 * are ignored so forward-compatible config blocks never break the runtime.
 */
export function resolveBrowserConfig(overrides?: Partial<BrowserConfig> | null): BrowserConfig {
  if (!overrides) return { ...DEFAULT_BROWSER_CONFIG };
  const base: BrowserConfig = { ...DEFAULT_BROWSER_CONFIG };
  for (const key of Object.keys(overrides) as Array<keyof BrowserConfig>) {
    if (key in base && overrides[key] !== undefined) {
      (base as unknown as Record<string, unknown>)[key] = overrides[key];
    }
  }
  return base;
}
