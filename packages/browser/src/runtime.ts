/**
 * BrowserRuntime — the core Playwright-backed browser abstraction (Phase 1).
 *
 * The runtime owns a single Chromium browser process and exposes isolated
 * browser sessions (each with its own context + page). All interaction with
 * Playwright is contained here; callers (tools, QA orchestration, flows) work
 * against this stable surface rather than Playwright internals.
 *
 * The browser process is guarded so it is never leaked: close() tears down all
 * sessions and the browser, process signals are handled, and every session is
 * reference-counted and released on close.
 */

import { chromium, type Browser as PW_Browser, type BrowserContext, type Page } from "playwright-core";
import { resolveBrowserConfig, type BrowserConfig } from "./config.js";
import { BrowserError } from "./errors.js";
import { createEventBus, type BrowserEventBus } from "./events.js";
import { createLogger, type AurexLogger } from "./logger.js";
import { isUrlAllowed, sanitizeHeaders, sanitizeSecrets } from "./security.js";
import type { ConsoleEntry, NetworkEntry, SessionHandle, Viewport, ViewportPreset } from "./types.js";
import { inspectPage, type PageInspectionResult } from "./inspection.js";
import { runAccessibilityCheck, type AccessibilityResult } from "./accessibility.js";
import { detectResponsiveIssues, type ResponsiveReport, type ResponsiveViewportResult } from "./responsive.js";
import { wireCapture } from "./capture.js";
import { withActionTimeout } from "./timeout.js";
import { shortSettle } from "./timing.js";
import { writeScreenshot } from "./storage.js";

export interface BrowserLaunchOptions {
  config?: Partial<BrowserConfig>;
  logger?: AurexLogger;
  eventBus?: BrowserEventBus;
}

export interface SessionDescriptor {
  sessionId: string;
  url: string | null;
  viewport: Viewport;
  createdAt: string;
  lastActivity: string;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  element?: string;
  /** When true, omit base64 data and return only metadata + path. */
  metadataOnly?: boolean;
}

export interface ScreenshotResult {
  path: string;
  data: string | null;
  width: number;
  height: number;
  url: string;
  timestamp: string;
}

interface SessionState extends SessionHandle {
  id: string;
  context: BrowserContext;
  page: Page;
  createdAt: string;
  lastActivity: string;
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
}

export class BrowserRuntime {
  readonly config: BrowserConfig;
  readonly events: BrowserEventBus;
  readonly logger: AurexLogger;
  private browser: PW_Browser | null = null;
  private sessions = new Map<string, SessionState>();
  private launchPromise: Promise<PW_Browser> | null = null;
  private _closed = false;

  constructor(opts: BrowserLaunchOptions = {}) {
    this.config = resolveBrowserConfig(opts.config);
    this.logger = opts.logger ?? createLogger({ baseFields: { module: "browser" } });
    this.events = opts.eventBus ?? createEventBus();
  }

  get closed(): boolean {
    return this._closed;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  async launch(): Promise<void> {
    if (this._closed) throw new BrowserError("Browser runtime is closed.");
    if (this.browser) return;
    if (!this.launchPromise) this.launchPromise = this.doLaunch();
    await this.launchPromise;
  }

  private async doLaunch(): Promise<PW_Browser> {
    const res = {
      channel: this.config.channel,
      executablePath: this.config.executablePath,
    };
    try {
      const browser = await chromium.launch({
        headless: this.config.headless,
        channel: res.channel ?? undefined,
        executablePath: res.executablePath ?? undefined,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-background-networking"],
      });
      this.browser = browser;
      browser.on("disconnected", () => {
        this.logger.warn("chromium process disconnected");
        const dead = new Map(this.sessions);
        this.sessions.clear();
        for (const s of dead.values()) {
          this.events.emit("browser.session.closed", { sessionId: s.id, reason: "browser-disconnected" }, s.id);
        }
      });
      this.logger.info("chromium launched", { channel: res.channel, executablePath: res.executablePath });
      return browser;
    } catch (e) {
      this.launchPromise = null;
      const msg = e instanceof Error ? e.message : String(e);
      if (/(executable|browser|locate|playwright)/i.test(msg)) {
        throw new BrowserError(
          `Could not launch Chromium.\n\n${launchHint(res)}\n\nUnderlying error: ${msg}`,
        );
      }
      throw new BrowserError(`Failed to launch Chromium: ${msg}`);
    }
  }

  /** Start a new isolated session with its own browser context + page. */
  async newSession(opts: {
    viewport?: Viewport;
    preset?: ViewportPreset;
    width?: number;
    height?: number;
    sessionId?: string;
  } = {}): Promise<string> {
    await this.launch();
    const browser = this.requireBrowser();
    const viewport: Viewport = opts.preset
      ? resolvePreset(opts.preset)
      : opts.viewport ?? { width: opts.width ?? this.config.viewportWidth, height: opts.height ?? this.config.viewportHeight };
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const sessionId = opts.sessionId ?? randomId("brow");
    const state: SessionState = {
      sessionId,
      id: sessionId,
      context,
      page,
      viewport,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      consoleEntries: [],
      networkEntries: [],
      config: this.config,
      logger: this.logger,
      events: this.events,
    };
    wireCapture(state);
    this.sessions.set(sessionId, state);
    this.events.emit("browser.session.created", { sessionId, viewport }, sessionId);
    this.logger.info("session created", { sessionId, viewport });
    return sessionId;
  }

  private requireBrowser(): PW_Browser {
    if (!this.browser) throw new BrowserError("Browser is not launched. Call launch() first.");
    return this.browser;
  }

  private getSession(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s) throw new BrowserError(`No browser session '${sessionId}'. Create one with newSession().`);
    return s;
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  describeSession(sessionId: string): SessionDescriptor | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return {
      sessionId,
      url: safeUrl(s.page),
      viewport: { ...s.viewport },
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
    };
  }

  listSessions(): SessionDescriptor[] {
    return this.sessionIds()
      .map((id) => this.describeSession(id))
      .filter((d): d is SessionDescriptor => d !== null);
  }

  // --- navigation ----------------------------------------------------------

  async open(sessionId: string, url: string): Promise<PageInspectionResult> {
    const s = this.getSession(sessionId);
    const allow = isUrlAllowed(url, this.config);
    if (!allow.allowed) {
      throw new BrowserError(`Navigation blocked: ${allow.reason}`);
    }
    const full = normalizeUrl(url, s.page.url());
    this.touch(s);
    this.events.emit("browser.navigation.started", { url: full }, sessionId);
    try {
      await s.page.goto(full, { waitUntil: "load", timeout: this.config.navigationTimeoutMs });
    } catch (e) {
      this.events.emit("browser.navigation.failed", { url: full, error: message(e) }, sessionId);
      throw new BrowserError(buildNavigationError(full, e), { cause: e });
    }
    this.events.emit("browser.navigation.completed", { url: s.page.url() }, sessionId);
    return inspectPage(s);
  }

  async url(sessionId: string): Promise<string> {
    return this.getSession(sessionId).page.url();
  }

  // --- inspection ----------------------------------------------------------

  inspect(sessionId: string): Promise<PageInspectionResult> {
    const s = this.getSession(sessionId);
    this.touch(s);
    return inspectPage(s);
  }

  async getDOM(sessionId: string, opts: { concise?: boolean } = {}): Promise<{ html: string; text: string }> {
    const s = this.getSession(sessionId);
    this.touch(s);
    const html = await s.page.evaluate(() => document.documentElement.outerHTML);
    const text = await s.page.evaluate(() => document.body?.innerText ?? "");
    if (opts.concise) {
      return { html: html.slice(0, 200_000), text: text.slice(0, 100_000) };
    }
    return { html: truncate(html, 300_000), text: truncate(text, 100_000) };
  }

  // --- interactions --------------------------------------------------------

  async click(sessionId: string, selector: string): Promise<void> {
    const s = this.getSession(sessionId);
    this.touch(s);
    await withActionTimeout(this.config, () => s.page.click(selector));
  }

  async fill(sessionId: string, selector: string, value: string): Promise<void> {
    const s = this.getSession(sessionId);
    this.touch(s);
    await withActionTimeout(this.config, () => s.page.fill(selector, value ?? ""));
  }

  async type(sessionId: string, selector: string, text: string, delayMs?: number): Promise<void> {
    const s = this.getSession(sessionId);
    this.touch(s);
    await withActionTimeout(this.config, () => s.page.type(selector, text, { delay: delayMs ?? 0 }));
  }

  async press(sessionId: string, selector: string | null, key: string): Promise<void> {
    const s = this.getSession(sessionId);
    this.touch(s);
    if (selector) {
      await withActionTimeout(this.config, () => s.page.press(selector, key));
    } else {
      await withActionTimeout(this.config, () => s.page.keyboard.press(key));
    }
  }

  async select(sessionId: string, selector: string, options: string | string[]): Promise<void> {
    const s = this.getSession(sessionId);
    this.touch(s);
    await withActionTimeout(this.config, () => s.page.selectOption(selector, options));
  }

  async scroll(sessionId: string, x: number, y: number): Promise<void> {
    const s = this.getSession(sessionId);
    this.touch(s);
    await s.page.evaluate(([dx, dy]) => window.scrollBy(dx, dy), [x, y] as const);
  }

  async scrollIntoView(sessionId: string, selector: string): Promise<void> {
    const s = this.getSession(sessionId);
    this.touch(s);
    await withActionTimeout(this.config, () => s.page.locator(selector).scrollIntoViewIfNeeded());
  }

  async waitForSelector(sessionId: string, selector: string, opts: { state?: "visible" | "hidden" | "attached" | "detached"; timeoutMs?: number } = {}): Promise<void> {
    const s = this.getSession(sessionId);
    this.touch(s);
    const timeout = opts.timeoutMs ?? this.config.actionTimeoutMs;
    await s.page.waitForSelector(selector, { state: opts.state ?? "visible", timeout }).catch((e) => {
      throw new BrowserError(`Element '${selector}' did not reach state '${opts.state ?? "visible"}' within ${timeout}ms: ${message(e)}`);
    });
  }

  async waitForTimeout(sessionId: string, ms: number): Promise<void> {
    const s = this.getSession(sessionId);
    this.touch(s);
    await s.page.waitForTimeout(ms);
  }

  async expectText(sessionId: string, text: string, opts: { match?: "contains" | "exact"; timeoutMs?: number } = {}): Promise<boolean> {
    const s = this.getSession(sessionId);
    this.touch(s);
    const timeout = opts.timeoutMs ?? this.config.actionTimeoutMs;
    const timeoutMs = timeout;
    try {
      if (opts.match === "exact") {
        await s.page.getByText(text, { exact: true }).first().waitFor({ timeout: timeoutMs });
      } else {
        await s.page.getByText(text).first().waitFor({ timeout: timeoutMs });
      }
      return true;
    } catch (e) {
      throw new BrowserError(`Expected text '${text}' not found within ${timeoutMs}ms.\n\nPossible causes:\n- content did not render\n- the route is wrong\n- the text differs from what is shown`);
    }
  }

  // --- evaluate ------------------------------------------------------------

  async evaluate<T = unknown>(sessionId: string, expression: string): Promise<T> {
    const s = this.getSession(sessionId);
    this.touch(s);
    let value = await s.page.evaluate(expression) as unknown;
    if (this.config.sanitizeOutput) {
      value = JSON.parse(sanitizeSecrets(safeSerialize(value)));
    }
    return value as T;
  }

  // --- screenshot ----------------------------------------------------------

  async screenshot(sessionId: string, opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const s = this.getSession(sessionId);
    this.touch(s);
    let buffer: Buffer;
    if (opts.element) {
      buffer = await s.page.locator(opts.element).screenshot();
    } else {
      buffer = await s.page.screenshot({ fullPage: opts.fullPage ?? false });
    }
    const url = s.page.url();
    const timestamp = new Date().toISOString();
    let path = "";
    if (this.config.outputDir) {
      path = await writeScreenshot(this.config.outputDir, buffer, sessionId, timestamp);
    }
    const dim = await s.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    this.events.emit("browser.screenshot.created", { sessionId, path, url, timestamp }, sessionId);
    return {
      path,
      data: opts.metadataOnly ? null : buffer.toString("base64"),
      width: dim.w,
      height: dim.h,
      url,
      timestamp,
    };
  }

  // --- capture -------------------------------------------------------------

  async consoleLogs(sessionId: string): Promise<ConsoleEntry[]> {
    const s = this.getSession(sessionId);
    this.touch(s);
    if (this.config.sanitizeOutput) {
      return s.consoleEntries.map((e) => ({ ...e, text: sanitizeSecrets(e.text) }));
    }
    return s.consoleEntries;
  }

  async networkLogs(sessionId: string): Promise<NetworkEntry[]> {
    const s = this.getSession(sessionId);
    this.touch(s);
    if (this.config.sanitizeOutput) {
      return s.networkEntries.map((e) => ({ ...e, headers: sanitizeHeaders(e.headers) }));
    }
    return s.networkEntries;
  }

  // --- accessibility -------------------------------------------------------

  accessibility(sessionId: string): Promise<AccessibilityResult> {
    const s = this.getSession(sessionId);
    this.touch(s);
    return runAccessibilityCheck(s);
  }

  // --- responsive ----------------------------------------------------------

  async responsiveTest(sessionId: string, presets: ViewportPreset[] | Viewport[]): Promise<ResponsiveReport> {
    const s = this.getSession(sessionId);
    const list: Array<{ label: string; viewport: Viewport }> = presets.map((p) => {
      if (typeof p === "string") return { label: p, viewport: resolvePreset(p) };
      return { label: `${p.width}x${p.height}`, viewport: p };
    });
    const results: ResponsiveViewportResult[] = [];
    for (const { label, viewport } of list) {
      await s.page.setViewportSize(viewport);
      const issues = await detectResponsiveIssues(s.page, viewport);
      results.push({ label, viewport, issues });
    }
    await s.page.setViewportSize(s.viewport);
    await shortSettle(s.page);
    return { results };
  }

  // --- lifecycle -----------------------------------------------------------

  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try { await s.page.close(); } catch { /* ignore */ }
    try { await s.context.close(); } catch { /* ignore */ }
    this.sessions.delete(sessionId);
    this.events.emit("browser.session.closed", { sessionId, reason: "closed" }, sessionId);
    this.logger.info("session closed", { sessionId });
  }

  async closeAllSessions(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.closeSession(id);
    }
  }

  /** Close the browser and all sessions. Idempotent. */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    await this.closeAllSessions();
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
    }
    this.browser = null;
    this.launchPromise = null;
    this.logger.info("browser runtime closed", {});
  }

  private touch(s: SessionState) {
    s.lastActivity = new Date().toISOString();
  }
}

// --- helpers -------------------------------------------------------------

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function safeSerialize(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify(String(v));
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n…[truncated]" : s;
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolvePreset(preset: ViewportPreset): Viewport {
  switch (preset) {
    case "desktop": return { width: 1440, height: 900 };
    case "tablet": return { width: 768, height: 1024 };
    case "mobile": return { width: 390, height: 844 };
  }
}

function normalizeUrl(url: string, current: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url;
  try {
    const base = new URL(current);
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

function safeUrl(page: Page): string | null {
  try {
    return page.url();
  } catch {
    return null;
  }
}

function launchHint(res: { channel: string | null; executablePath: string | null }): string {
  const lines = [
    "Possible causes:",
    "- Playwright browsers are not installed (run `npx playwright install chromium`).",
  ];
  if (res.channel) lines.push(`- The browser channel '${res.channel}' is not installed on this machine.`);
  if (res.executablePath) lines.push(`- The executablePath '${res.executablePath}' does not exist.`);
  return lines.join("\n");
}

function buildNavigationError(url: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return [
    "Browser navigation failed.",
    "",
    "URL:",
    url,
    "",
    "Reason:",
    msg,
    "",
    "Possible causes:",
    "- application is not running",
    "- application startup failed",
    "- port is incorrect",
    "- route does not exist",
  ].join("\n");
}
