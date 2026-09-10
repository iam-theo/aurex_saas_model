/**
 * ApplicationRuntime — start/stop the application under test (Phase 3).
 *
 * Detects the application from its project files, discovers a start command
 * and the expected port, starts it, waits for readiness, and stops it. This is
 * the layer that lets the QA loop build → start → open → inspect.
 *
 * Command execution is provided by a caller-supplied "runner" abstraction so
 * this module works both inside the workspace container (shell) and under test
 * (in-process child processes). Nothing here hardcodes a port or host.
 */

import { projectFolder } from "@aurex/shared";

export interface CommandRunner {
  /** Run a command and resolve with its combined output. */
  run(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<string>;
  /** Start a command detached (no wait for exit) and return a handle. */
  start(command: string, opts?: { cwd?: string }): Promise<{ pid?: number; stop(): Promise<void> }>;
}

export interface ApplicationConfig {
  startCommand?: string;
  url?: string;
  port?: number;
}

export interface ApplicationDetection {
  framework?: string;
  startCommand: string;
  port: number;
  url: string;
  via: "config" | "detected" | "default";
}

export interface Application {
  name: string;
  cwd: string;
  detection: ApplicationDetection;
  handle?: { stop(): Promise<void> };
  status: "stopped" | "starting" | "running" | "error";
  startedAt?: string;
}

export interface ApplicationRuntimeOptions {
  runner: CommandRunner;
  cwd?: string;
  config?: ApplicationConfig;
  framework?: string;
  name?: string;
  /** Host/port used when the app binds to 0.0.0.0 but is reached via a base URL. */
  proxyHost?: string;
  defaultPort?: number;
}

const DEFAULT_PORTS: Record<string, number> = {
  vite: 5173,
  "next": 3000,
  "nuxt": 3000,
  "react": 5173,
  "vue": 5173,
  "angular": 4200,
  "svelte": 5173,
  "express": 3000,
  "node": 3000,
  "laravel": 8000,
  "laravel-artisan": 8000,
};

/**
 * Inspect project files and resolve how to run the application. Returns null
 * when no app is detectable (not a web project).
 */
export async function detectApplication(opts: {
  runner: CommandRunner;
  cwd: string;
  config?: ApplicationConfig;
  framework?: string;
  defaultPort?: number;
}): Promise<ApplicationDetection | null> {
  const { cwd, runner } = opts;

  // 1. Explicit config always wins.
  if (opts.config?.startCommand || opts.config?.url || opts.config?.port) {
    const startCommand = opts.config.startCommand ?? null;
    const url: string | undefined = opts.config.url ?? undefined;
    const port = opts.config.port ?? urlPort(url) ?? null;
    if (startCommand || port !== null) {
      return {
        startCommand: startCommand ?? `npm run dev`,
        port: port ?? opts.defaultPort ?? 3000,
        url: url ?? `http://localhost:${port ?? opts.defaultPort ?? 3000}`,
        via: "config",
      };
    }
  }

  // 2. Inspect package.json.
  const pkgRaw = await runner.run("cat package.json 2>/dev/null || true", { cwd, timeoutMs: 5000 }).catch(() => "");
  const pkg = parseJson(pkgRaw) as Record<string, unknown> | null;
  const scripts = (pkg?.scripts as Record<string, string> | undefined) ?? {};
  const deps = {
    ...((pkg?.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg?.devDependencies as Record<string, unknown>) ?? {}),
  };
  const lock = await firstFile(runner, cwd, ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lock"]);
  const pm = lock === "pnpm-lock.yaml" ? "pnpm" : lock === "yarn.lock" ? "yarn" : lock === "bun.lock" ? "bun" : "npm";

  const framework = opts.framework ?? detectFrameworkFromDeps(deps);

  // Start command: prefer a known dev script naming, else fall back to run scripts.
  const startCommand =
    opts.config?.startCommand ??
    pickStart(scripts, pm) ??
    (scripts.dev ? `${pm} run dev` : scripts.start ? `${pm} start` : null);

  const port = opts.config?.port ?? portFor(framework, deps, opts.defaultPort);
  const url = opts.config?.url ?? `http://localhost:${port}`;

  // Composer / PHP.
  if (!startCommand && await fileExists(runner, cwd, "composer.json")) {
    const composerRaw = await runner.run("cat composer.json 2>/dev/null || true", { cwd, timeoutMs: 5000 }).catch(() => "");
    const composer = parseJson(composerRaw) as Record<string, unknown> | null;
    const laravel = composer?.require && (composer.require as Record<string, unknown>)["laravel/framework"];
    if (laravel) {
      return {
        framework: "Laravel",
        startCommand: "php artisan serve",
        port: opts.config?.port ?? 8000,
        url: opts.config?.url ?? `http://localhost:${opts.config?.port ?? 8000}`,
        via: "detected",
      };
    }
  }

  if (!startCommand) return null;

  const via: ApplicationDetection["via"] = opts.config ? "config" : "detected";
  return { framework, startCommand, port, url, via };
}

export class ApplicationRuntime {
  private app: Application | null = null;
  private runner: CommandRunner;
  private cwd: string;
  private detection: ApplicationDetection | null = null;
  readonly defaultPort: number;

  constructor(opts: ApplicationRuntimeOptions) {
    this.runner = opts.runner;
    this.cwd = opts.cwd ?? "/workspace";
    this.defaultPort = opts.defaultPort ?? 3000;
    // Preload config-derived detection for sync access.
    this.detection = opts.config ? {
      startCommand: opts.config.startCommand ?? "npm run dev",
      port: opts.config.port ?? urlPort(opts.config.url) ?? this.defaultPort,
      url: opts.config.url ?? `http://localhost:${opts.config.port ?? urlPort(opts.config.url) ?? this.defaultPort}`,
      via: "config",
    } : null;
  }

  get detectionInfo(): ApplicationDetection | null {
    return this.detection;
  }

  async detect(): Promise<ApplicationDetection> {
    const detection = await detectApplication({
      runner: this.runner,
      cwd: this.cwd,
      config: undefined,
      framework: undefined,
      defaultPort: this.defaultPort,
    });
    if (!detection) {
      throw new Error(
        "Could not detect how to start this application.\n\n" +
        "Possible causes:\n" +
        "- no package.json / composer.json found\n" +
        "- no dev/start script defined\n\n" +
        "Fix: add a dev script or set browser.startCommand in config.",
      );
    }
    this.detection = detection;
    return detection;
  }

  async ensureDetected(): Promise<ApplicationDetection> {
    if (this.detection) return this.detection;
    return this.detect();
  }

  async start(opts: { wait?: boolean; readinessTimeoutMs?: number } = {}): Promise<Application> {
    const detection = await this.ensureDetected();
    if (this.app && this.app.status === "running") return this.app;

    this.app = {
      name: projectFolder(this.cwd.split("/").pop() ?? "app"),
      cwd: this.cwd,
      detection,
      status: "starting",
      startedAt: new Date().toISOString(),
    };
    const handle = await this.runner.start(detection.startCommand, { cwd: this.cwd }).catch((e) => {
      this.app!.status = "error";
      throw new Error(`Failed to start application ('${detection.startCommand}'): ${e instanceof Error ? e.message : String(e)}`);
    });
    this.app.handle = handle;
    if (opts.wait !== false) {
      await this.waitUntilReady(opts.readinessTimeoutMs ?? 60_000);
    }
    return this.app;
  }

  async waitUntilReady(timeoutMs = 60_000): Promise<void> {
    if (!this.app) throw new Error("application not started");
    const detection = this.app.detection;
    const url = detection.url;
    const deadline = Date.now() + timeoutMs;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const out = await this.runner.run(
          `curl -s -o /dev/null -w "%{http_code}" --max-time 3 "${url}" 2>/dev/null || echo 000`,
          { cwd: this.cwd, timeoutMs: 6000 },
        );
        const code = out.trim();
        if (/^[1-5][0-9]{2}$/.test(code) && code !== "000") {
          this.app.status = "running";
          return;
        }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await delay(700);
    }
    this.app.status = "error";
    throw new Error(
      `Application never became ready at ${url} within ${Math.round(timeoutMs / 1000)}s.\n\n` +
      `Start command: ${detection.startCommand}\n` +
      (lastErr ? `Last probe error: ${lastErr}\n` : "") +
      `\nPossible causes:\n- the dev server failed to start\n- the port is different (set browser.port)\n- a build/install step is required first`,
    );
  }

  async stop(): Promise<void> {
    if (this.app?.handle) {
      try { await this.app.handle.stop(); } catch { /* ignore */ }
    }
    if (this.app) {
      this.app.status = "stopped";
    }
  }

  async status(): Promise<Application["status"]> {
    if (!this.app) return "stopped";
    return this.app.status;
  }

  url(): string {
    return this.detection?.url ?? "unknown";
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detectFrameworkFromDeps(deps: Record<string, unknown>): string | undefined {
  const order: Array<[string, string]> = [
    ["next", "Next.js"],
    ["nuxt", "Nuxt"],
    ["@angular/core", "Angular"],
    ["vue", "Vue"],
    ["svelte", "Svelte"],
    ["react", "React"],
    ["express", "Express"],
    ["@nestjs/core", "NestJS"],
    ["fastify", "Fastify"],
  ];
  for (const [dep, name] of order) {
    if (deps[dep] !== undefined) return name;
  }
  return undefined;
}

function pickStart(scripts: Record<string, string>, pm: string): string | null {
  const preferred = ["dev", "serve", "start", "preview"];
  for (const name of preferred) {
    if (scripts[name]) {
      const cmd = `${pm} run ${name}`;
      return cmd;
    }
  }
  return null;
}

function portFor(framework: string | undefined, deps: Record<string, unknown>, dflt?: number): number {
  if (deps.vite !== undefined || deps["@vitejs/plugin-react"] !== undefined) return 5173;
  if (framework) {
    const hit = DEFAULT_PORTS[framework.toLowerCase()];
    if (hit) return hit;
  }
  if (deps["next"]) return 3000;
  if (deps["@angular/core"]) return 4200;
  if (deps["express"]) return 3000;
  return dflt ?? 3000;
}

function urlPort(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const p = new URL(url).port;
    return p ? Number(p) : null;
  } catch {
    return null;
  }
}

async function firstFile(runner: CommandRunner, cwd: string, files: string[]): Promise<string | null> {
  for (const f of files) {
    if (await fileExists(runner, cwd, f)) return f;
  }
  return null;
}

async function fileExists(runner: CommandRunner, cwd: string, f: string): Promise<boolean> {
  try {
    const out = await runner.run(`test -f "${f}" && echo yes || echo no`, { cwd, timeoutMs: 5000 });
    return out.trim() === "yes";
  } catch {
    return false;
  }
}

export { projectFolder };
