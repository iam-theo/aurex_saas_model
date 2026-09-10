/**
 * Action timeout helper.
 *
 * Wraps a Playwright action with the configured timeout and converts the
 * underlying errors into actionable, human-readable messages for the agent.
 */

import type { BrowserConfig } from "./config.js";
import { BrowserError } from "./errors.js";

export type ActionFn = () => Promise<unknown>;

export async function withActionTimeout(
  config: Pick<BrowserConfig, "actionTimeoutMs">,
  fn: ActionFn,
): Promise<void> {
  try {
    await wrapTimeout(fn, config.actionTimeoutMs);
  } catch (e) {
    throw actionError(e, config.actionTimeoutMs);
  }
}

function wrapTimeout(fn: ActionFn, ms: number): Promise<unknown> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`operation timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function actionError(e: unknown, ms: number): BrowserError {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.toLowerCase().includes("timeout")) {
    return new BrowserError(
      `Browser action timed out after ${ms}ms.\n\nPossible causes:\n- element is not present or hidden\n- the page is busy / never settled\n- the selector does not match any element`,
    );
  }
  if (msg.toLowerCase().includes("strict mode violation")) {
    return new BrowserError(`Selector is not unique — it matches multiple elements. Make the selector more specific.`);
  }
  if (msg.toLowerCase().includes("was detached") || msg.toLowerCase().includes("not attached")) {
    return new BrowserError(`The element was detached from the DOM (page re-rendered). Retry the action on the current page.`);
  }
  return new BrowserError(`Browser action failed: ${msg}`);
}
