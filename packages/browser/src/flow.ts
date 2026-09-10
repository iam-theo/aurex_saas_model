/**
 * User flow execution (Phase 9).
 *
 * A declarative, step-based browser workflow that orchestrates the runtime.
 * Credentials are never stored in the flow definition — values like
 * `{{TEST_PASSWORD}}` are resolved from environment variables / a secret
 * resolver at execution time.
 */

import type { BrowserRuntime } from "./runtime.js";

export type FlowAction =
  | "open"
  | "click"
  | "fill"
  | "type"
  | "press"
  | "select"
  | "scroll"
  | "wait"
  | "expectText"
  | "expectVisible"
  | "expectHidden"
  | "expectUrl"
  | "screenshot";

export interface FlowStep {
  action: FlowAction;
  url?: string;
  selector?: string;
  value?: string;
  key?: string;
  text?: string;
  options?: string | string[];
  x?: number;
  y?: number;
  ms?: number;
  seconds?: number;
  exact?: boolean;
  label?: string;
}

export interface FlowDefinition {
  name: string;
  steps: FlowStep[];
}

export interface FlowOptions {
  /** Resolver for `{{SOME_VAR}}` placeholders in values/urls. */
  resolveSecret?: (name: string) => string | undefined;
  /** Base URL for relative `open` steps. */
  baseUrl?: string;
  /** When true, a failed step stops execution. Default true. */
  stopOnError?: boolean;
}

export type SecretResolver = (name: string) => string | undefined;

export interface FlowResult {
  name: string;
  startedAt: string;
  completedAt: string;
  passed: boolean;
  stepsCompleted: number;
  stepsTotal: number;
  failedStep: number | null;
  error?: string;
}

const NAMED_ACTIONS: FlowAction[] = [
  "open", "click", "fill", "type", "press", "select", "scroll", "wait",
  "expectText", "expectVisible", "expectHidden", "expectUrl", "screenshot",
];

export function validateFlow(flow: FlowDefinition): { valid: boolean; error?: string } {
  if (!flow || typeof flow.name !== "string" || !Array.isArray(flow.steps)) {
    return { valid: false, error: "flow must have a name and a steps array" };
  }
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    if (!NAMED_ACTIONS.includes(step.action)) {
      return { valid: false, error: `step ${i + 1} has unsupported action '${step.action}'` };
    }
  }
  return { valid: true };
}

export class UnknownSecretError extends Error {
  constructor(name: string) {
    super(`Secret '${name}' referenced by the flow is not defined in the environment.`);
    this.name = "UnknownSecretError";
  }
}

export async function executeFlow(
  runtime: BrowserRuntime,
  sessionId: string,
  flow: FlowDefinition,
  opts: FlowOptions = {},
): Promise<FlowResult> {
  const validation = validateFlow(flow);
  if (!validation.valid) throw new Error(validation.error);

  const startedAt = new Date().toISOString();
  const resolveSecret =
    opts.resolveSecret ??
    ((name: string) => process.env[name]);

  let stepsCompleted = 0;
  let failedStep: number | null = null;
  let error: string | undefined;

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    try {
      await executeStep(runtime, sessionId, step, { resolveSecret, baseUrl: opts.baseUrl });
      stepsCompleted++;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      failedStep = i + 1;
      if (opts.stopOnError !== false) break;
    }
  }

  const passed = failedStep === null;
  return {
    name: flow.name,
    startedAt,
    completedAt: new Date().toISOString(),
    passed,
    stepsCompleted,
    stepsTotal: flow.steps.length,
    failedStep,
    ...(error ? { error } : {}),
  };
}

async function executeStep(
  runtime: BrowserRuntime,
  sessionId: string,
  step: FlowStep,
  ctx: { resolveSecret: SecretResolver; baseUrl?: string },
): Promise<void> {
  const resolve = (v?: string): string | undefined => {
    if (v == null) return v;
    return v.replace(/\{\{\s*([A-Z0-9._-]+)\s*\}\}/g, (m, name: string) => {
      const val = ctx.resolveSecret(name);
      if (val === undefined) throw new UnknownSecretError(name);
      return val;
    });
  };

  switch (step.action) {
    case "open": {
      let url = resolve(step.url) ?? "/";
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && ctx.baseUrl) {
        url = new URL(url, ensureTrailingSlash(ctx.baseUrl)).toString();
      }
      await runtime.open(sessionId, url);
      break;
    }
    case "click":
      require(step.selector, "click");
      await runtime.click(sessionId, step.selector!);
      break;
    case "fill":
      require(step.selector, "fill");
      await runtime.fill(sessionId, step.selector!, resolve(step.value) ?? "");
      break;
    case "type": {
      require(step.selector, "type");
      await runtime.type(sessionId, step.selector!, resolve(step.value) ?? "");
      break;
    }
    case "press": {
      await runtime.press(sessionId, step.selector ?? null, resolve(step.key) ?? "Enter");
      break;
    }
    case "select":
      require(step.selector, "select");
      await runtime.select(sessionId, step.selector!, resolveSelectOptions(step.options, ctx.resolveSecret));
      break;
    case "scroll":
      await runtime.scroll(sessionId, step.x ?? 0, step.y ?? 0);
      break;
    case "wait":
      await runtime.waitForTimeout(sessionId, step.ms ?? (step.seconds ?? 1) * 1000);
      break;
    case "expectText":
      await runtime.expectText(sessionId, resolve(step.text) ?? resolve(step.value) ?? "", { match: step.exact ? "exact" : "contains" });
      break;
    case "expectVisible":
      require(step.selector, "expectVisible");
      await runtime.waitForSelector(sessionId, step.selector!, { state: "visible" });
      break;
    case "expectHidden":
      require(step.selector, "expectHidden");
      await runtime.waitForSelector(sessionId, step.selector!, { state: "hidden" });
      break;
    case "expectUrl": {
      const target = resolve(step.text) ?? resolve(step.value) ?? step.url ?? "";
      const current = await runtime.url(sessionId);
      const tUrl = ctx.baseUrl ? new URL(target, ensureTrailingSlash(ctx.baseUrl)).toString() : target;
      const cUrl = new URL(current).toString();
      if (!cUrl.startsWith(tUrl) && cUrl !== tUrl) {
        throw new Error(`Expected URL to match '${tUrl}' but the page is at '${current}'`);
      }
      break;
    }
    case "screenshot":
      await runtime.screenshot(sessionId, { fullPage: false });
      break;
    default:
      throw new Error(`Unsupported flow action '${(step as FlowStep).action}'`);
  }
}

function require(v: string | undefined, action: string): asserts v is string {
  if (!v) throw new Error(`Flow step '${action}' requires a 'selector'`);
}

function resolveSelectOptions(options: string | string[] | undefined, resolver: SecretResolver): string | string[] {
  if (options === undefined) return "";
  const r = (s: string) => s.replace(/\{\{\s*([A-Z0-9._-]+)\s*\}\}/g, (m, name: string) => resolver(name) ?? m);
  if (Array.isArray(options)) return options.map(r);
  return r(options);
}

function ensureTrailingSlash(base: string): string {
  return base.endsWith("/") ? base : base + "/";
}

export { resolveSecretFromEnv as defaultSecretResolver };
function resolveSecretFromEnv(name: string): string | undefined {
  return process.env[name];
}
