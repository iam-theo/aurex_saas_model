/**
 * Browser tool definitions (Phase 2).
 *
 * Describes the browser operations exposed to the agent as tools. Each tool
 * has strong input validation (a schema), a useful description, structured
 * output, timeout handling and safe resource cleanup. The definitions here are
 * framework-agnostic; the opencode plugin adapter maps them onto opencode's
 * `tool()` helper, and other adapters (CLI, tests) can do the same.
 */

import { BrowserRuntime } from "./runtime.js";
import { BrowserError } from "./errors.js";
import type { PageInspectionResult } from "./inspection.js";

export type ToolIO = "string" | "number" | "boolean" | "string[]";

export interface ToolParam {
  name: string;
  type: ToolIO;
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface BrowserToolDef<A = Record<string, unknown>> {
  /** opencode-style tool name, e.g. "browser.open". */
  name: string;
  description: string;
  args: ToolParam[];
  /** Execute against the runtime. Errors should be thrown as Error with actionable messages. */
  run(args: A, ctx: ToolContext): Promise<unknown>;
}

export interface ToolContext {
  runtime: BrowserRuntime;
  /** Optional session id supplied by the caller, else the runtime default. */
  sessionId?: string;
  log?: (level: "debug" | "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function pickParams(
  args: Record<string, unknown>,
  defs: ToolParam[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of defs) {
    const raw = args[p.name];
    if (raw === undefined) {
      if (p.required) throw new ToolInputError(`Missing required argument '${p.name}': ${p.description}`);
      if (p.default !== undefined) out[p.name] = p.default;
      continue;
    }
    out[p.name] = coerce(p.name, raw, p.type);
  }
  return out;
}

function coerce(name: string, value: unknown, type: ToolIO): unknown {
  switch (type) {
    case "string":
      if (typeof value === "string") return value;
      if (typeof value === "number") return String(value);
      throw new ToolInputError(`Argument '${name}' must be a string`);
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) throw new ToolInputError(`Argument '${name}' must be a number`);
      return n;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      throw new ToolInputError(`Argument '${name}' must be a boolean`);
    case "string[]":
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
      if (typeof value === "string") return [value];
      throw new ToolInputError(`Argument '${name}' must be an array of strings`);
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const SESSION_ARG: ToolParam = {
  name: "session",
  type: "string",
  description: "Browser session id (from browser.launch). Omit to reuse the current session.",
  required: false,
};

function log(ctx: ToolContext, msg: string) {
  ctx.log?.("info", msg);
}

export function buildBrowserTools(runtime: () => BrowserRuntime): BrowserToolDef[] {
  return [
    {
      name: "browser.launch",
      description: "Launch the browser (if not already running) and create a new isolated session. Returns the session id used by all other browser tools.",
      args: [
        {
          name: "width",
          type: "number",
          description: "Viewport width. Default 1440.",
          required: false,
        },
        {
          name: "height",
          type: "number",
          description: "Viewport height. Default 900.",
          required: false,
        },
        {
          name: "preset",
          type: "string",
          description: "Viewport preset: desktop, tablet, or mobile.",
          required: false,
        },
      ],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = await rt.newSession({
          width: args["width"] as number | undefined,
          height: args["height"] as number | undefined,
          preset: (args["preset"] as "desktop" | "tablet" | "mobile" | undefined) ?? undefined,
        });
        const desc = rt.describeSession(sessionId);
        log(ctx, `browser launched; session ${sessionId}`);
        return { sessionId, ...(desc ?? {}) };
      },
    },

    {
      name: "browser.open",
      description: "Navigate the current session to a URL (absolute or relative to the app being tested).",
      args: [
        SESSION_ARG,
        { name: "url", type: "string", description: "The URL to open, e.g. http://localhost:5173/dashboard", required: true },
        { name: "baseUrl", type: "string", description: "Optional base URL to resolve relative paths against.", required: false },
      ],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        let url = args["url"] as string;
        const baseUrl = args["baseUrl"] as string | undefined;
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && baseUrl) {
          url = new URL(url, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/").toString();
        }
        const result = await rt.open(sessionId, url);
        return summarizeInspection(result);
      },
    },

    {
      name: "browser.inspect",
      description: "Inspect the current page: URL, title, headings, visible text, forms, links, interactive elements, console errors, network errors, and broken images.",
      args: [SESSION_ARG],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        const result = await rt.inspect(sessionId);
        return summarizeInspection(result);
      },
    },

    {
      name: "browser.screenshot",
      description: "Take a screenshot of the current page (full page, viewport, or a specific element). Returns the file path and dimensions.",
      args: [
        SESSION_ARG,
        { name: "fullPage", type: "boolean", description: "Capture the full scrollable page. Default false.", required: false },
        { name: "element", type: "string", description: "CSS selector of an element to screenshot instead of the viewport.", required: false },
        { name: "includeData", type: "boolean", description: "Include base64 image data in the response. Default false.", required: false },
      ],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        const shot = await rt.screenshot(sessionId, {
          fullPage: Boolean(args["fullPage"]),
          element: args["element"] as string | undefined,
          metadataOnly: !args["includeData"],
        });
        return shot;
      },
    },

    {
      name: "browser.click",
      description: "Click an element matching a CSS selector.",
      args: [SESSION_ARG, { name: "selector", type: "string", description: "CSS selector of the element to click.", required: true }],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        await rt.click(sessionId, args["selector"] as string);
        return { ok: true };
      },
    },

    {
      name: "browser.fill",
      description: "Fill a form field (input/textarea) with a value.",
      args: [
        SESSION_ARG,
        { name: "selector", type: "string", description: "CSS selector of the field.", required: true },
        { name: "value", type: "string", description: "The value to enter.", required: true },
      ],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        await rt.fill(sessionId, args["selector"] as string, args["value"] as string);
        return { ok: true };
      },
    },

    {
      name: "browser.type",
      description: "Type text into a field, keystroke by keystroke (slower, triggers per-key events).",
      args: [
        SESSION_ARG,
        { name: "selector", type: "string", description: "CSS selector of the field.", required: true },
        { name: "value", type: "string", description: "The text to type.", required: true },
      ],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        await rt.type(sessionId, args["selector"] as string, args["value"] as string);
        return { ok: true };
      },
    },

    {
      name: "browser.press",
      description: "Press a keyboard key (e.g. Enter, Tab, Escape) on a focused element or globally.",
      args: [
        SESSION_ARG,
        { name: "key", type: "string", description: "The key to press, e.g. Enter, Tab, Escape, ArrowDown.", required: true },
        { name: "selector", type: "string", description: "Optional selector to focus before pressing.", required: false },
      ],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        await rt.press(sessionId, (args["selector"] as string | undefined) ?? null, args["key"] as string);
        return { ok: true };
      },
    },

    {
      name: "browser.select",
      description: "Select option(s) in a <select> element.",
      args: [
        SESSION_ARG,
        { name: "selector", type: "string", description: "CSS selector of the <select>.", required: true },
        { name: "values", type: "string[]", description: "Option value(s) to select.", required: true },
      ],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        await rt.select(sessionId, args["selector"] as string, args["values"] as string | string[]);
        return { ok: true };
      },
    },

    {
      name: "browser.scroll",
      description: "Scroll the page or bring a selector into view.",
      args: [
        SESSION_ARG,
        { name: "x", type: "number", description: "Horizontal scroll delta.", required: false },
        { name: "y", type: "number", description: "Vertical scroll delta.", required: false },
        { name: "selector", type: "string", description: "Optional selector to scroll into view.", required: false },
      ],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        const sel = args["selector"] as string | undefined;
        if (sel) await rt.scrollIntoView(sessionId, sel);
        else await rt.scroll(sessionId, Number(args["x"] ?? 0), Number(args["y"] ?? 0));
        return { ok: true };
      },
    },

    {
      name: "browser.evaluate",
      description: "Run a JavaScript expression in the page and return the result. Use for advanced checks (caveat: runs in the page context).",
      args: [
        SESSION_ARG,
        { name: "expression", type: "string", description: "A JavaScript expression that evaluates to a serializable value.", required: true },
      ],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        const value = await rt.evaluate(sessionId, args["expression"] as string);
        return { value };
      },
    },

    {
      name: "browser.dom",
      description: "Get the page's outer HTML and visible text (for debugging / verification).",
      args: [SESSION_ARG, { name: "textOnly", type: "boolean", description: "Return only visible text, not HTML. Default true.", required: false }],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        const dom = await rt.getDOM(sessionId, { concise: true });
        return args["textOnly"] === false ? dom : { text: dom.text };
      },
    },

    {
      name: "browser.console",
      description: "Return captured console logs, including errors and warnings.",
      args: [SESSION_ARG],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        const logs = await rt.consoleLogs(sessionId);
        return { entries: logs.slice(-200) };
      },
    },

    {
      name: "browser.network",
      description: "Return captured network requests, including failed requests and 4xx/5xx responses.",
      args: [SESSION_ARG],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        const logs = await rt.networkLogs(sessionId);
        return { entries: logs.slice(-200) };
      },
    },

    {
      name: "browser.accessibility",
      description: "Run an accessibility check on the current page: labels, accessible names, image alt text, heading structure, keyboard access.",
      args: [SESSION_ARG],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        const result = await rt.accessibility(sessionId);
        return result;
      },
    },

    {
      name: "browser.responsive",
      description: "Test the current page across multiple viewport sizes (desktop, tablet, mobile) and report layout problems (overflow, overlap, clipped content, tap targets).",
      args: [
        SESSION_ARG,
        {
          name: "presets",
          type: "string[]",
          description: "Presets to test: desktop, tablet, mobile. Default all three.",
          required: false,
        },
      ],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        const presets = (args["presets"] as string[] | undefined) ?? ["desktop", "tablet", "mobile"];
        const report = await rt.responsiveTest(sessionId, presets as unknown as import("./types.js").ViewportPreset[]);
        return report;
      },
    },

    {
      name: "browser.trace",
      description: "Return a summary of the browser session's activity for diagnostics.",
      args: [SESSION_ARG],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        const desc = rt.describeSession(sessionId);
        if (!desc) throw new BrowserError(`Session '${sessionId}' not found`);
        return {
          session: desc,
          sessions: rt.listSessions(),
          consoleErrors: (await rt.consoleLogs(sessionId)).filter((l) => l.type === "error").length,
          networkErrors: (await rt.networkLogs(sessionId)).filter((n) => n.failed || (n.status !== null && n.status >= 400)).length,
        };
      },
    },

    {
      name: "browser.close",
      description: "Close the current browser session, releasing its resources. Does not close other sessions.",
      args: [SESSION_ARG],
      async run(args, ctx) {
        const rt = runtime();
        const sessionId = (args["session"] as string | undefined) ?? ctx.sessionId ?? firstSession(rt);
        await rt.closeSession(sessionId);
        return { ok: true, closed: sessionId };
      },
    },
  ];
}

function firstSession(rt: BrowserRuntime): string {
  const ids = rt.sessionIds();
  if (ids.length === 0) {
    throw new BrowserError(
      "No browser session. Call browser.launch first to create a session.",
    );
  }
  return ids[ids.length - 1];
}

function summarizeInspection(result: PageInspectionResult): unknown {
  return {
    url: result.url,
    title: result.title,
    viewport: result.viewport,
    headings: result.headings.slice(0, 10),
    visibleText: result.visibleText.slice(0, 2000),
    links: result.links.slice(0, 25),
    forms: result.forms,
    interactiveElements: result.interactiveElements.slice(0, 30),
    brokenImages: result.brokenImages,
    consoleErrors: result.consoleErrors.slice(0, 20),
    networkErrors: result.networkErrors.slice(0, 20),
  };
}
