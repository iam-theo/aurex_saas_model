/**
 * Browser security controls (Phase 13).
 *
 * Responsibilities:
 *  - Constrain which hosts/ports the browser may navigate to.
 *  - Block access to sensitive local services and cloud metadata endpoints.
 *  - Sanitize browser output so secrets (headers, cookies, tokens) never reach
 *    the model.
 */

import type { BrowserConfig } from "./config.js";

export interface HostAllowance {
  allowed: boolean;
  reason?: string;
}

const CLOUD_METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "169.254.169.254",
  "metadata.azure.internal",
  "100.100.100.200",
  "169.254.170.2",
  "192.0.0.192",
]);

const SENSITIVE_AUTH_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-forwarded-api-key",
  "cookie",
  "set-cookie",
  "x-aws-authorization",
  "x-amz-security-token",
]);

const SENSITIVE_HEADER_VALUES = new Set(["token", "secret", "password", "passwd", "api-key", "api_key", "apikey", "credential", "jwt", "bearer"]);

/**
 * Decide whether the browser is allowed to open a given URL.
 * When `allowedHosts` is non-empty it acts as an allowlist; otherwise localhost
 * and loopback are always allowed and cloud/private metadata hosts are blocked.
 */
export function isUrlAllowed(url: string, config: Pick<BrowserConfig, "allowedHosts">): HostAllowance {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "invalid url" };
  }

  const host = parsed.hostname.toLowerCase();
  if (CLOUD_METADATA_HOSTS.has(host)) {
    return { allowed: false, reason: "cloud/local metadata endpoint is blocked" };
  }

  const allowlist = config.allowedHosts;
  if (Object.keys(allowlist).length > 0) {
    const allow = allowlist[host];
    if (!allow) return { allowed: false, reason: `host '${host}' is not in browser.allowedHosts` };
    if (allow !== "*") {
      const ports = allow.split(",").map((p) => p.trim()).filter(Boolean);
      const port = parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "");
      if (ports.length > 0 && !ports.includes(port)) {
        return { allowed: false, reason: `host '${host}' only allows ports [${allow}]` };
      }
    }
    return { allowed: true };
  }

  // No allowlist: forbid arbitrary private ranges except loopback.
  if (isPrivateHost(host)) {
    if (isLoopback(host)) return { allowed: true };
    return { allowed: false, reason: `private host '${host}' is not allowed without an explicit allowlist` };
  }

  const blocked = config_blocked_detail(url);
  if (blocked) return { allowed: false, reason: blocked };

  return { allowed: true };
}

function config_blocked_detail(_url: string): string | null {
  return null;
}

export function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h === "127.0.0.1" || /^127\./.test(h) || h === "[::1]";
}

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (isLoopback(h)) return true;
  if (CLOUD_METADATA_HOSTS.has(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

/**
 * Blocklist for request URLs that should never be surfaced to the agent
 * (internal credential/secret endpoints). Applied during network capture.
 */
export function isRequestUrlBlocked(url: string, patterns: string[]): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (CLOUD_METADATA_HOSTS.has(host)) return true;
  } catch {
    /* ignore */
  }
  for (const pat of patterns) {
    if (pat && url.includes(pat)) return true;
  }
  return false;
}

/** True when an HTTP header may safely be shown to the agent. */
export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_AUTH_HEADERS.has(name.toLowerCase());
}

/** True when a header's value looks like a credential and must be redacted. */
export function headerValueLooksSensitive(name: string, value: string): boolean {
  const lowerName = name.toLowerCase();
  if (isSensitiveHeader(lowerName)) return true;
  const v = value.toLowerCase();
  return SENSITIVE_HEADER_VALUES.has(lowerName) || (/^[a-z0-9._-]+$/i.test(lowerName) && v.length > 24);
}

/** Redact the value of a header that carries a credential. */
export function redactHeaderValue(name: string, value: string): string {
  return headerValueLooksSensitive(name, value) ? "[REDACTED]" : value;
}

/**
 * Redact obvious secrets in a body of text (console output, page text, etc.).
 * Targets common credential patterns; a plain key does not get mangled.
 */
export function sanitizeSecrets(text: string): string {
  return text
    .replace(/\b(?:api[_-]?key|token|secret|password|passwd|authorization|bearer)\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}["']?/gi, "$1=[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{12,}/gi, "$1 [REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_KEY]")
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "sk-[REDACTED]")
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "ghp_[REDACTED]");
}

/**
 * Sanitize a set of request headers for agent consumption: drops sensitive
 * headers entirely and redacts any remaining values that look like secrets.
 */
export function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (isSensitiveHeader(k)) continue;
    if (headerValueLooksSensitive(k, v)) out[k] = "[REDACTED]";
    else out[k] = v;
  }
  return out;
}
