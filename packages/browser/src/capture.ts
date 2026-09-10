/**
 * Console + network capture (Phase 5).
 *
 * Wires a live Playwright page to record console output and network requests.
 * Console errors/warnings and failed/4xx/5xx requests are surfaced; the output
 * is sanitized for secrets before it reaches the agent.
 */

import type { SessionHandle, ConsoleEntry, NetworkEntry } from "./types.js";
import { isRequestUrlBlocked, sanitizeHeaders } from "./security.js";

export function wireCapture(handle: SessionHandle): void {
  const { page, events, logger, sessionId, config } = handle;
  const blocked = config.blockedUrlPatterns ?? [];

  page.on("console", (msg) => {
    const type = msg.type();
    const entry: ConsoleEntry = {
      type: normalizeConsoleType(type),
      text: msg.text(),
      location: messageLocation(msg),
    };
    handle.consoleEntries.push(entry);
    if (type === "error") {
      events.emit("browser.console.error", { sessionId, text: entry.text }, sessionId);
    }
  });

  page.on("pageerror", (err) => {
    const entry: ConsoleEntry = {
      type: "error",
      text: `Uncaught exception: ${err.message}`,
    };
    handle.consoleEntries.push(entry);
    events.emit("browser.console.error", { sessionId, text: entry.text }, sessionId);
    logger.warn("page javascript error", { sessionId, error: err.message });
  });

  page.on("requestfailed", (req) => {
    if (isRequestUrlBlocked(req.url(), blocked)) return;
    const entry: NetworkEntry = {
      url: req.url(),
      method: req.method(),
      status: null,
      resourceType: req.resourceType(),
      failed: true,
      error: req.failure()?.errorText ?? "request failed",
      headers: {},
    };
    handle.networkEntries.push(entry);
    events.emit("browser.network.error", { sessionId, url: entry.url, error: entry.error }, sessionId);
  });

  page.on("response", (res) => {
    if (isRequestUrlBlocked(res.url(), blocked)) return;
    const status = res.status();
    if (status >= 400) {
      const entry: NetworkEntry = {
        url: res.url(),
        method: res.request().method(),
        status,
        resourceType: res.request().resourceType(),
        failed: status >= 500,
        headers: config.sanitizeOutput
          ? sanitizeHeaders(res.headers() as Record<string, string>)
          : (res.headers() as Record<string, string>),
      };
      handle.networkEntries.push(entry);
      if (status >= 500) {
        events.emit("browser.network.error", { sessionId, url: entry.url, status }, sessionId);
      }
    }
  });
}

function normalizeConsoleType(t: string): ConsoleEntry["type"] {
  switch (t) {
    case "warning": return "warning";
    case "error": return "error";
    case "debug": return "debug";
    case "info": return "info";
    default: return "log";
  }
}

function messageLocation(msg: { location?: () => { url?: string; lineNumber?: number } }): string | undefined {
  try {
    if (typeof msg.location !== "function") return undefined;
    const loc = msg.location();
    if (loc && loc.url) {
      return `${loc.url}:${loc.lineNumber ?? 0}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export { sanitizeHeaders };
