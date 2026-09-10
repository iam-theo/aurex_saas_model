/**
 * Browser QA orchestration loop (Phase 10).
 *
 * Drives the full build → start → open → inspect → diagnose → repair → verify
 * loop with a configurable iteration cap so an uncontrolled infinite loop is
 * impossible.
 *
 * The loop is deliberately decoupled from any particular coding agent via the
 * `AgentDriver` interface: the worker supplies a driver that runs a real
 * opencode session in the workspace to apply fixes; tests supply a stub.
 */

import type { BrowserRuntime } from "./runtime.js";
import type { ApplicationRuntime } from "./application.js";
import type { AccessibilityResult } from "./accessibility.js";
import type { ResponsiveReport } from "./responsive.js";
import type { PageInspectionResult } from "./inspection.js";
import type { VisualAnalyzer } from "./visual.js";

export interface BrowserQAConfig {
  enabled: boolean;
  maxIterations: number;
  screenshots: boolean;
  console: boolean;
  network: boolean;
  accessibility: boolean;
  responsive: boolean;
  /** Route(s) to test; empty = just the base URL. */
  paths: string[];
  /** How long to wait for the app to become ready. */
  readinessTimeoutMs: number;
}

export const DEFAULT_QA_CONFIG: BrowserQAConfig = {
  enabled: true,
  maxIterations: 5,
  screenshots: true,
  console: true,
  network: true,
  accessibility: true,
  responsive: true,
  paths: ["/"],
  readinessTimeoutMs: 60_000,
};

export interface Findings {
  failures: Finding[];
  warnings: Finding[];
}

export interface Finding {
  category: "console" | "network" | "accessibility" | "responsive" | "runtime";
  severity: "high" | "medium" | "low";
  description: string;
  evidence?: string;
}

/** A driver that can run a repair task against the codebase and report back. */
export interface AgentDriver {
  readonly name: string;
  /** Run a repair task; resolve with the agent's final text output. */
  applyFix(context: {
    task: string;
    cwd: string;
    runId?: string;
    iteration: number;
  }): Promise<{ output: string; changed: boolean }>;
}

export interface QASnapshot {
  url: string;
  inspection: PageInspectionResult;
  accessibility?: AccessibilityResult;
  responsive?: ResponsiveReport;
  screenshotPath: string | null;
}

export interface QAIteration {
  number: number;
  snapshots: QASnapshot[];
  findings: Finding[];
  passed: boolean;
  repairTask?: string;
  repairOutput?: string;
  repaired?: boolean;
}

export interface QAResult {
  status: "passed" | "failed" | "cancelled";
  appUrl: string;
  startedAt: string;
  completedAt: string;
  iterations: number;
  maxIterations: number;
  totalFindings: number;
  pagesTested: string[];
  consoleErrors: number;
  networkErrors: number;
  accessibilityIssues: number;
  visualIssues: number;
  functionalIssues: number;
  iterationsDetail: QAIteration[];
  report: string;
}

export interface BrowserQAOptions {
  runtime: BrowserRuntime;
  app: ApplicationRuntime;
  analyzer?: VisualAnalyzer;
  driver?: AgentDriver;
  config?: Partial<BrowserQAConfig>;
  logs?: (line: string) => void;
}

export async function runBrowserQA(opts: BrowserQAOptions): Promise<QAResult> {
  const config: BrowserQAConfig = { ...DEFAULT_QA_CONFIG, ...(opts.config ?? {}) };
  if (!config.enabled) {
    throw new Error("Browser QA is disabled (browserQA.enabled=false).");
  }
  const log = opts.logs ?? (() => {});
  const startedAt = new Date().toISOString();
  const iterationsDetail: QAIteration[] = [];
  const driver = opts.driver ?? EMPTY_DRIVER;

  log(`QA started; max iterations ${config.maxIterations}`);

  const appDetection = await opts.app.detect();
  await opts.app.start({ wait: true, readinessTimeoutMs: config.readinessTimeoutMs });
  const appUrl = opts.app.url();

  const sessionId = await opts.runtime.newSession();
  const cntErrors = { console: 0, network: 0, accessibility: 0, visual: 0, functional: 0 };

  try {
    let passed = false;
    for (let iter = 1; iter <= config.maxIterations; iter++) {
      log(`\n=== Iteration ${iter}/${config.maxIterations} ===`);
      const snapshots: QASnapshot[] = [];
      const findings: Finding[] = [];

      for (const path of config.paths.length ? config.paths : ["/"]) {
        const url = new URL(path, ensureSlash(appUrl)).toString();
        const inspection = await navigateAndInspect(opts.runtime, sessionId, url, log);

        let a11y: AccessibilityResult | undefined;
        if (config.accessibility) {
          a11y = await opts.runtime.accessibility(sessionId);
          findings.push(...accessibilityFindings(a11y));
          cntErrors.accessibility += a11y.summary.critical + a11y.summary.serious;
        }

        let responsive: ResponsiveReport | undefined;
        if (config.responsive) {
          responsive = await opts.runtime.responsiveTest(sessionId, ["desktop", "tablet", "mobile"]);
          findings.push(...responsiveFindings(responsive));
          cntErrors.visual += responsiveTotal(responsive);
        }

        if (config.console) {
          const errs = (await opts.runtime.consoleLogs(sessionId)).filter((e) => e.type === "error");
          findings.push(...consoleFindings(errs));
          cntErrors.console += errs.length;
        }
        if (config.network) {
          const netErrs = await opts.runtime.networkLogs(sessionId);
          const failures = netErrs.filter((e) => e.failed || (e.status !== null && e.status >= 400));
          findings.push(...networkFindings(failures));
          cntErrors.network += failures.length;
        }

        let screenshotPath: string | null = null;
        if (config.screenshots) {
          const shot = await opts.runtime.screenshot(sessionId, { fullPage: false });
          screenshotPath = shot.path || null;
        }

        snapshots.push({ url, inspection, accessibility: a11y, responsive, screenshotPath });
      }

      const iterationFindings = dedupe(findings);
      const iterPassed = iterationFindings.length === 0 && cntErrors.console === 0 && cntErrors.network === 0;
      const iteration: QAIteration = {
        number: iter,
        snapshots,
        findings: iterationFindings,
        passed: iterPassed,
      };
      iterationsDetail.push(iteration);

      if (iterPassed) {
        passed = true;
        log(`\n✓ Passed on iteration ${iter}`);
        break;
      }

      log(`\n✗ Failed: ${iterationFindings.length} finding(s) — dispatching repair to agent.`);
      const repairTask = buildRepairTask(iterationFindings, snapshots);
      iteration.repairTask = repairTask;
      let repairResult: { output: string; changed: boolean };
      try {
        repairResult = await driver.applyFix({
          task: repairTask,
          cwd: opts.app.url().length ? "." : ".",
          iteration: iter,
        });
        iteration.repairOutput = repairResult.output;
        iteration.repaired = repairResult.changed;
      } catch (e) {
        iteration.repairOutput = `Repair failed: ${e instanceof Error ? e.message : String(e)}`;
        iteration.repaired = false;
        log(`Repair driver error: ${iteration.repairOutput}`);
      }

      if (iter === config.maxIterations) {
        log(`Reached max iterations (${config.maxIterations}); stopping.`);
        break;
      }
    }

    const completedAt = new Date().toISOString();
    const status: QAResult["status"] = passed ? "passed" : "failed";
    return {
      status,
      appUrl,
      startedAt,
      completedAt,
      iterations: iterationsDetail.length,
      maxIterations: config.maxIterations,
      totalFindings: iterationsDetail.reduce((n, i) => n + i.findings.length, 0),
      pagesTested: config.paths,
      consoleErrors: cntErrors.console,
      networkErrors: cntErrors.network,
      accessibilityIssues: cntErrors.accessibility,
      visualIssues: cntErrors.visual,
      functionalIssues: cntErrors.functional,
      iterationsDetail,
      report: buildReport(status, appUrl, iterationsDetail, cntErrors, config),
    };
  } finally {
    await opts.runtime.closeSession(sessionId).catch(() => {});
    await opts.app.stop().catch(() => {});
  }
}

async function navigateAndInspect(
  runtime: BrowserRuntime,
  sessionId: string,
  url: string,
  log: (l: string) => void,
): Promise<PageInspectionResult> {
  log(`  opening ${url}`);
  return runtime.open(sessionId, url);
}

function accessibilityFindings(a11y: AccessibilityResult): Finding[] {
  return a11y.issues.map((issue) => ({
    category: "accessibility",
    severity: issue.severity === "critical" ? "high" : issue.severity === "serious" ? "medium" : "low",
    description: `[a11y/${issue.code}] ${issue.description}`,
    evidence: issue.selector ? `at ${issue.selector}` : undefined,
  }));
}

function responsiveFindings(responsive: ResponsiveReport): Finding[] {
  const out: Finding[] = [];
  for (const r of responsive.results) {
    for (const issue of r.issues) {
      out.push({
        category: "responsive",
        severity: issue.severity,
        description: `[responsive/${issue.code} @${r.label}] ${issue.description}`,
        evidence: issue.selector,
      });
    }
  }
  return out;
}

function consoleFindings(errs: Array<{ text: string }>): Finding[] {
  return errs.map((e) => ({
    category: "console",
    severity: "high",
    description: `Console error: ${e.text.slice(0, 400)}`,
  }));
}

function networkFindings(failures: Array<{ url: string; status: number | null; failed?: boolean }>): Finding[] {
  return failures.map((f) => ({
    category: "network",
    severity: f.status !== null && f.status < 500 ? "medium" : "high",
    description: `Network ${f.failed ? "failure" : `error ${f.status}`}: ${f.url}`,
  }));
}

function responsiveTotal(r: ResponsiveReport): number {
  return r.results.reduce((n, x) => n + x.issues.length, 0);
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.category}:${f.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function buildRepairTask(findings: Finding[], snapshots: QASnapshot[]): string {
  const urls = snapshots.map((s) => s.url).join(", ");
  const lines = findings.map((f) => `- [${f.severity}] ${f.description}${f.evidence ? ` (${f.evidence})` : ""}`);
  return [
    `The browser QA check found problems on ${urls}. Fix the following issues in the code:`,
    ...lines,
    ``,
    `After fixing, ensure the app still builds and the dev server starts.`,
  ].join("\n");
}

function buildReport(
  status: string,
  appUrl: string,
  iterations: QAIteration[],
  cnt: { console: number; network: number; accessibility: number; visual: number; functional: number },
  config: BrowserQAConfig,
): string {
  const finalIter = iterations[iterations.length - 1];
  const pages = config.paths.join(", ");
  const changes = (finalIter?.repairOutput ?? "")
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 10)
    .join("\n");
  return [
    "AUREX BROWSER QA REPORT",
    "",
    "Application:",
    appUrl,
    "",
    "Status:",
    status.toUpperCase(),
    "",
    "Iterations:",
    String(iterations.length),
    "",
    "Pages tested:",
    `- ${pages.split(", ").join("\n- ")}`,
    "",
    "Console errors:",
    String(cnt.console),
    "Network errors:",
    String(cnt.network),
    "Accessibility issues:",
    String(cnt.accessibility),
    "Visual issues:",
    String(cnt.visual),
    "Functional issues:",
    String(cnt.functional),
    "",
    ...(changes ? ["Changes made:", changes] : []),
    "",
    "Final verification:",
    status.toUpperCase(),
  ].join("\n");
}

function ensureSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/";
}

const EMPTY_DRIVER: AgentDriver = {
  name: "none",
  async applyFix() {
    return { output: "", changed: false };
  },
};
