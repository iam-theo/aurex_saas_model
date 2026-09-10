/**
 * Aurex Browser plugin for opencode.
 *
 * Registers the `browser.*` tools (launch/open/inspect/screenshot/click/fill/
 * type/press/select/scroll/evaluate/dom/console/network/accessibility/
 * responsive/trace/close) with opencode so the coding agent can drive a real
 * Chromium browser to build → start → open → inspect → verify.
 *
 * opencode loads this plugin from the workspace container's plugin directory
 * and compiles it with bun. It imports the compiled `@aurex/browser` package,
 * which must be resolvable inside the container (see @aurex/worker's
 * browserPlugin module for installation).
 */

// opencode plugin is only available inside the workspace container at runtime.
// Provide a fallback stub for host-side typecheck/build.
type ToolFactory = (opts: { description: string; args: unknown; execute: (args: unknown) => Promise<unknown> }) => unknown;
let tool: ToolFactory = (opts: unknown) => opts as unknown;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = eval("require")("@opencode-ai/plugin") as { tool: ToolFactory };
  if (m?.tool) tool = m.tool;
} catch {
  // stub remains — inside container the real plugin will be resolved at runtime
}
import { z } from "zod";
import {
  BrowserRuntime,
  buildBrowserTools,
  pickParams,
  type BrowserToolDef,
} from "@aurex/browser";

let runtimePromise: Promise<BrowserRuntime> | null = null;
let cachedRuntime: BrowserRuntime | null = null;

function getRuntime(): Promise<BrowserRuntime> {
  runtimePromise ??= (async () => {
    const runtime = new BrowserRuntime({
      config: {
        headless: (process.env.AUREX_BROWSER_HEADLESS ?? "true") !== "false",
        executablePath: process.env.AUREX_BROWSER_EXECUTABLE_PATH ?? null,
        channel: process.env.AUREX_BROWSER_CHANNEL ?? null,
        allowedHosts: parseAllowedHosts(process.env.AUREX_BROWSER_ALLOWED_HOSTS),
        outputDir: process.env.AUREX_BROWSER_OUTPUT_DIR ?? null,
        maxIterations: Number(process.env.AUREX_BROWSER_MAX_ITERATIONS ?? 5) || 5,
      },
    });
    cachedRuntime = runtime;
    // Never leak Chromium: tear down when the opencode process exits.
    process.once("exit", () => {
      void runtime.close().catch(() => {});
    });
    return runtime;
  })();
  return runtimePromise;
}

function getRuntimeSync(): BrowserRuntime {
  if (!cachedRuntime) throw new Error("Browser runtime not initialized — call browser.launch first");
  return cachedRuntime;
}

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

function toArgs(args: unknown, def: BrowserToolDef): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  return pickParams(args as Record<string, unknown>, def.args);
}

/** Register every browser tool definition as an opencode custom tool. */
export const AurexBrowser = () => {
  const toolMap: Record<string, ReturnType<typeof tool>> = {};

  const runFn = async (def: BrowserToolDef, args: unknown) => {
    try {
      const ctx = { runtime: await getRuntime() };
      return await def.run(toArgs(args, def), ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: msg, ok: false };
    }
  };

  for (const def of buildBrowserTools(() => getRuntimeSync())) {
    toolMap[def.name] = (tool as unknown as (o: unknown) => unknown)({
      description: def.description,
      args: objectToZod(def),
      async execute(args: unknown) {
        return runFn(def, args);
      },
    });
  }

  return { tool: toolMap };
};

function objectToZod(def: BrowserToolDef): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of def.args) {
    let schema: z.ZodTypeAny;
    switch (p.type) {
      case "number":
        schema = z.number();
        break;
      case "boolean":
        schema = z.boolean();
        break;
      case "string[]":
        schema = z.array(z.string());
        break;
      default:
        schema = z.string();
        break;
    }
    if (!p.required) {
      schema = schema.optional();
    }
    shape[p.name] = schema;
  }
  return z.object(shape);
}
