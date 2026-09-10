import { spawn } from "node:child_process";
import { homedir as _hd } from "node:os";
import dns from "node:dns";
import { request } from "node:https";
import { prisma } from "@aurex/db";
import { containerState, execDetach, execStream, startWorkspace, workspaceContainerName } from "@aurex/docker";
import { projectWorkspacePath, workspaceRunDirectory } from "@aurex/shared";

async function resolveProjectWorkspace(_userId: string | undefined, projectId: string) {
  // Worker has no auth context — resolve workspace directly via DB
  const ws = await prisma.workspace.findUnique({ where: { projectId } });
  if (ws) return ws;
  // Fallback: personal workspace most recently updated (host mode may have only personal ws)
  return prisma.workspace.findFirst({ orderBy: { updatedAt: "desc" } });
}

const _HOME = process.env.HOME ?? _hd() ?? "/home/aurex";
const TUNNEL_CONFIG = process.env.AUREX_TUNNEL_CONFIG ?? `${_HOME}/.cloudflared/config.yml`;
const TUNNEL_NAME = process.env.AUREX_TUNNEL_NAME ?? "auracle-tunnel";
const NPROXY_HELPER = process.env.AUREX_NPROXY_HELPER ?? "/usr/local/sbin/aurex-publish";
const WEBROOT = process.env.AUREX_WEBROOT ?? "/var/www/html";
const BACKEND_PORT = Number(process.env.AUREX_BACKEND_PORT ?? 4000);
const AGENT_HOME = process.env.AUREX_AGENT_HOME ?? "/home/agent";
export const PUBLISH_DOMAIN = (() => {
  if (process.env.AUREX_PUBLISH_DOMAIN) return process.env.AUREX_PUBLISH_DOMAIN.trim().replace(/^\.+/, "");
  const base = process.env.AUREX_PUBLIC_BASE_URL;
  if (base) try { const h = new URL(base).hostname; const p = h.split("."); if (p.length >= 2) return p.slice(-2).join("."); return h; } catch {}
  return "";
})();

// File lock for TUNNEL_CONFIG to prevent lost-update race between concurrent publishes (api + worker)
async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const { mkdir, rmdir } = await import("node:fs/promises");
  const lockDir = `${TUNNEL_CONFIG}.lock`;
  const start = Date.now();
  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() - start > 15000) throw new Error("timeout acquiring tunnel config lock");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lockDir).catch(() => {});
  }
}
async function atomicWriteConfig(path: string, content: string): Promise<void> {
  const { writeFile, rename, unlink, mkdir } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  // Ensure tmp is on same filesystem as target to guarantee atomic rename (EXDEV safe)
  let tmp: string;
  try {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    tmp = join(dir, `.aurex-tunnel-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`);
    await writeFile(tmp, content, "utf8");
  } catch {
    tmp = join(tmpdir(), `aurex-tunnel-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`);
    await writeFile(tmp, content, "utf8");
  }
  try {
    await rename(tmp, path);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EXDEV") {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(tmp, path);
      await unlink(tmp).catch(() => {});
    } else throw e;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

function getBackendPort(slug: string): number {
  // Deterministic per-slug port to allow multiple SSR apps in same workspace container.
  // Base 4000 + hash(slug) % 1000 -> 4000-4999, avoids collision for different slugs.
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return 4000 + (h % 1000);
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  );
}

function execLong(name: string, argv: string[], timeoutMs = 10 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdout, stderr, child } = execStream(name, argv);
    let out = "";
    let err = "";
    stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else {
        const cmd = `${name} ${argv.join(" ")}`.slice(0, 200);
        reject(new Error(err.trim() || out.trim().slice(-300) || `exit code ${code} (${cmd})`));
      }
    });
  });
}

function runHost(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd: opts?.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts?.timeoutMs ?? 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || out.trim().slice(-300) || `exit code ${code}`));
    });
  });
}

async function backendHealthy(container: string, port: number = BACKEND_PORT): Promise<boolean> {
  try {
    const code = await execLong(container, [
      "sh",
      "-c",
      `curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:${port}/ || true`,
    ]);
    return code.trim() === "200";
  } catch {
    return false;
  }
}

/**
 * Information about a detected frontend framework / package manager.
 */
interface FrameworkInfo {
  /** Human-readable framework name, e.g. "next", "vite", "cra", "django". */
  name: string;
  /** Language runtime: "js" or "python". */
  lang: "js" | "python";
  /** Install command (already includes the package-manager / pip prefix). */
  installCmd: string;
  /** Build command to run, e.g. "npm run build" or "python3 manage.py collectstatic". Empty if no build step. */
  buildCommand: string;
  /** Start command for the backend server, e.g. "npm run start" or "gunicorn app.wsgi:application". */
  startCommand: string;
  /** Directories (relative to project root) where the framework emits static output. */
  outputDirs: string[];
  /** Whether the framework needs a long-running server (SSR) rather than static files. */
  needsServer: boolean;
}

/**
 * Detect the JavaScript/TypeScript framework and package manager used by the
 * project living inside the workspace container.
 *
 * Detection strategy (in priority order):
 *   1. Package manager — from the `packageManager` field in package.json,
 *      refined by the presence of lockfiles (pnpm-lock.yaml > yarn.lock >
 *      package-lock.json).
 *   2. Framework — from dependencies in package.json and config-file presence
 *      (next.config.*, angular.json, vite.config.*, etc.).
 *
 * Returns enough information to run the correct install/build commands and
 * to know where to look for the built index.html.
 */
async function detectFramework(container: string, dir: string): Promise<FrameworkInfo> {
  // --- Read package.json ---
  let pkg: Record<string, unknown> = {};
  try {
    const raw = await execLong(container, ["sh", "-c", `cat "$1/package.json" 2>/dev/null || echo '{}'`, "sh", dir]);
    pkg = JSON.parse(raw || "{}");
  } catch {}

  const deps = {
    ...((pkg.dependencies || {}) as Record<string, string>),
    ...((pkg.devDependencies || {}) as Record<string, string>),
  };
  const packageManager = (pkg.packageManager as string | undefined) || "";

  // --- Detect package manager ---
  let pmCmd = "npm";
  if (packageManager.startsWith("pnpm")) pmCmd = "pnpm";
  else if (packageManager.startsWith("yarn")) pmCmd = "yarn";

  // Lockfiles override the packageManager field if present.
  const lockfiles = await execLong(
    container,
    ["sh", "-c", `for f in pnpm-lock.yaml yarn.lock package-lock.json bun.lockb; do [ -f "$1/$f" ] && echo "$f"; done || true`, "sh", dir],
  );
  if (lockfiles.includes("pnpm-lock.yaml")) pmCmd = "pnpm";
  else if (lockfiles.includes("yarn.lock")) pmCmd = "yarn";
  else pmCmd = "npm";

  // Derive install and start commands from the package manager.
  const installCmd =
    pmCmd === "pnpm"
      ? "pnpm install --no-frozen-lockfile"
      : pmCmd === "yarn"
        ? "yarn install"
        : "npm install --no-audit --no-fund";

  // --- Check for framework config files in a single shell pass ---
  const configFiles = [
    "next.config.js", "next.config.mjs", "next.config.ts", "next.config.jsx",
    "angular.json",
    "nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.jsx",
    "svelte.config.js", "svelte.config.mjs", "svelte.config.ts", "svelte.config.cjs",
    "vite.config.js", "vite.config.mjs", "vite.config.ts", "vite.config.jsx",
    "vue.config.js",
  ];
  const configChecks = configFiles.map((f) => `[ -f "$1/${f}" ] && echo "${f}"`).join(" || ");
  const configs = await execLong(
    container,
    ["sh", "-c", `cd "$1" && { ${configChecks}; } 2>/dev/null || true`, "sh", dir],
  );
  const hasConfig = (name: string) => configs.includes(name);

  // --- Detect framework (specific first) ---

  // Next.js
  const nextNames = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.jsx"];
  if (deps["next"] || nextNames.some(hasConfig)) {
    let staticExport = false;
    for (const f of nextNames) {
      if (hasConfig(f)) {
        try {
          const nc = await execLong(container, ["sh", "-c", `cat "$1/${f}" 2>/dev/null || echo ''`, "sh", dir]);
          if (/output\s*:\s*['"]export['"]/.test(nc)) {
            staticExport = true;
            break;
          }
        } catch {}
      }
    }
    return {
      name: "next",
      lang: "js",
      installCmd,
      buildCommand: `${pmCmd} run build`,
      startCommand: `${pmCmd} run start`,
      outputDirs: staticExport ? ["out"] : [".next/static", "out", "dist"],
      needsServer: !staticExport,
    };
  }

  // Angular
  if (hasConfig("angular.json") || deps["@angular/core"]) {
    return {
      name: "angular",
      lang: "js",
      installCmd,
      buildCommand: `${pmCmd} run build`,
      startCommand: `${pmCmd} run start`,
      outputDirs: ["dist"],
      needsServer: false,
    };
  }

  // Nuxt 3 / Nuxt
  const nuxtNames = ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.jsx"];
  if (deps["nuxt"] || deps["nuxt3"] || nuxtNames.some(hasConfig)) {
    return {
      name: "nuxt",
      lang: "js",
      installCmd,
      buildCommand: `${pmCmd} run build`,
      startCommand: `${pmCmd} run start`,
      outputDirs: ["dist", ".output/public"],
      needsServer: true,
    };
  }

  // SvelteKit
  const svelteNames = ["svelte.config.js", "svelte.config.mjs", "svelte.config.ts", "svelte.config.cjs"];
  if (deps["@sveltejs/kit"] || svelteNames.some(hasConfig)) {
    return {
      name: "sveltekit",
      lang: "js",
      installCmd,
      buildCommand: `${pmCmd} run build`,
      startCommand: `${pmCmd} run start`,
      outputDirs: [".svelte-kit"],
      needsServer: true,
    };
  }

  // Vue (Vue CLI or Vite + Vue)
  if (hasConfig("vue.config.js") || (deps["vue"] && deps["vite"]) || deps["@vue/cli-service"]) {
    return {
      name: "vue",
      lang: "js",
      installCmd,
      buildCommand: `${pmCmd} run build`,
      startCommand: `${pmCmd} run start`,
      outputDirs: ["dist"],
      needsServer: false,
    };
  }

  // Create React App
  if (deps["react-scripts"]) {
    return {
      name: "cra",
      lang: "js",
      installCmd,
      buildCommand: `${pmCmd} run build`,
      startCommand: `${pmCmd} run start`,
      outputDirs: ["build"],
      needsServer: false,
    };
  }

  // Vite (React, Preact, Vanilla, Lit, etc.)
  const viteNames = ["vite.config.js", "vite.config.mjs", "vite.config.ts", "vite.config.jsx"];
  if (deps["vite"] || viteNames.some(hasConfig)) {
    return {
      name: "vite",
      lang: "js",
      installCmd,
      buildCommand: `${pmCmd} run build`,
      startCommand: `${pmCmd} run start`,
      outputDirs: ["dist"],
      needsServer: false,
    };
  }

  // Generic fallback — use the default build script and common output dirs.
  return {
    name: "generic",
    lang: "js",
    installCmd,
    buildCommand: `${pmCmd} run build`,
    startCommand: `${pmCmd} run start`,
    outputDirs: ["dist", "build", "out"],
    needsServer: false,
  };
}

/**
 * Detect a Python web framework and produce the install/build/start commands.
 *
 * Detection strategy:
 *   1. Check for Python dependency files (requirements.txt, pyproject.toml, etc.)
 *   2. Read requirements.txt to identify installed packages
 *   3. Check for framework-specific markers (manage.py for Django, app.py/main.py for WSGI/ASGI)
 *   4. Check for a Procfile as a fallback
 */
async function detectPythonFramework(container: string, dir: string, port: number = BACKEND_PORT): Promise<FrameworkInfo | null> {
  const exists = async (name: string) =>
    (await execLong(container, ["sh", "-c", `[ -f "$1/${name}" ] && echo yes || echo no`, "sh", dir])).trim() === "yes";

  const hasReqs = await exists("requirements.txt");
  const hasPyProject = await exists("pyproject.toml");
  if (!hasReqs && !hasPyProject) return null;

  // Read requirements.txt if it exists
  let reqs = "";
  if (hasReqs) {
    reqs = await execLong(container, ["sh", "-c", `cat "$1/requirements.txt" 2>/dev/null || echo ''`, "sh", dir]);
  }

  // Read pyproject.toml dependencies if no requirements.txt
  if (!hasReqs && hasPyProject) {
    try {
      const pp = await execLong(container, ["sh", "-c", `cat "$1/pyproject.toml" 2>/dev/null || echo ''`, "sh", dir]);
      // Extract dependency names from [project.dependencies] or [tool.poetry.dependencies]
      const depMatch = pp.match(/(?:dependencies)\s*=\s*\[(.*?)\]/s);
      if (depMatch) reqs = depMatch[1];
    } catch {}
  }

  const hasManagePy = await exists("manage.py");
  const hasAppPy = await exists("app.py");
  const hasMainPy = await exists("main.py");
  const reqsLower = reqs.toLowerCase();

  const pyCmd = "python3";
  const installCmd = hasReqs
    ? "pip install -r requirements.txt"
    : "pip install .";

  /** Read the Django project name by finding the wsgi.py location. */
  async function detectDjangoProject(): Promise<string> {
    const wsgiPath = await execLong(container, ["sh", "-c",
      `ls -d "$1"/*/wsgi.py 2>/dev/null | head -1 | xargs -I{} dirname {} | xargs basename 2>/dev/null || true`,
      "sh", dir,
    ]);
    return wsgiPath.trim();
  }

  // Django
  if (hasManagePy || reqsLower.includes("django")) {
    const projectName = await detectDjangoProject();
    const startCommand = projectName
      ? `gunicorn ${projectName}.wsgi:application --bind 0.0.0.0:${port}`
      : `${pyCmd} manage.py runserver 0.0.0.0:${port}`;
    return {
      name: "django",
      lang: "python",
      installCmd,
      buildCommand: `${pyCmd} manage.py collectstatic --noinput`,
      startCommand,
      outputDirs: ["staticfiles", "static"],
      needsServer: true,
    };
  }

  // FastAPI
  if (reqsLower.includes("fastapi") || reqsLower.includes("uvicorn")) {
    const module = hasAppPy ? "app.main:app" : hasMainPy ? "main:app" : "app:app";
    return {
      name: "fastapi",
      lang: "python",
      installCmd,
      buildCommand: "",
      startCommand: `uvicorn ${module} --host 0.0.0.0 --port ${port}`,
      outputDirs: [],
      needsServer: true,
    };
  }

  // Flask
  if (reqsLower.includes("flask")) {
    const module = hasAppPy ? "app:app" : "main:app";
    return {
      name: "flask",
      lang: "python",
      installCmd,
      buildCommand: "",
      startCommand: `gunicorn ${module} --bind 0.0.0.0:${port}`,
      outputDirs: ["static"],
      needsServer: true,
    };
  }

  // Streamlit
  if (reqsLower.includes("streamlit")) {
    const entry = hasAppPy ? "app.py" : hasMainPy ? "main.py" : "app.py";
    return {
      name: "streamlit",
      lang: "python",
      installCmd,
      buildCommand: "",
      startCommand: `${pyCmd} -m streamlit run ${entry} --server.port ${port} --server.enableCORS false --server.headless true`,
      outputDirs: [],
      needsServer: true,
    };
  }

  // Gradio
  if (reqsLower.includes("gradio")) {
    const entry = hasAppPy ? "app.py" : hasMainPy ? "main.py" : "app.py";
    return {
      name: "gradio",
      lang: "python",
      installCmd,
      buildCommand: "",
      startCommand: `PORT=${port} HOST=0.0.0.0 ${pyCmd} ${entry}`,
      outputDirs: [],
      needsServer: true,
    };
  }

  // Procfile-based deployment (Heroku-style)
  const hasProcfile = await exists("Procfile");
  if (hasProcfile) {
    const procfile = await execLong(container, ["sh", "-c", `cat "$1/Procfile" 2>/dev/null || echo ''`, "sh", dir]);
    const webLine = procfile.split("\n").find((l) => l.trimStart().startsWith("web:"));
    if (webLine) {
      const cmd = webLine.split(":").slice(1).join(":").trim();
      return {
        name: "procfile",
        lang: "python",
        installCmd,
        buildCommand: "",
        startCommand: cmd,
        outputDirs: [],
        needsServer: true,
      };
    }
  }

  // Generic Python — try to infer a start command from common entry points.
  let startCommand = "";
  if (await exists("start.sh")) {
    startCommand = "bash start.sh";
  } else if (hasAppPy) {
    startCommand = `PORT=${port} ${pyCmd} app.py`;
  } else if (hasMainPy) {
    startCommand = `PORT=${port} ${pyCmd} main.py`;
  } else {
    startCommand = `${pyCmd} -m http.server ${port}`;
  }

  return {
    name: "generic-python",
    lang: "python",
    installCmd,
    buildCommand: "",
    startCommand,
    outputDirs: [],
    needsServer: true,
  };
}

/**
 * Ensure the host-side publishing infrastructure is set up:
 *   1. The nginx proxy helper script exists at NPROXY_HELPER.
 *   2. The nginx proxy config exists.
 *   3. The cloudflare tunnel is running with a catch-all rule.
 *
 * Called automatically at the start of every publish. Throws with a
 * descriptive message if setup cannot be completed.
 */
export async function ensurePublishSetup(): Promise<{ ok: boolean; details: string }> {
  const { existsSync, mkdirSync } = await import("node:fs");
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  // 1. Ensure the nginx helper script exists and is up-to-date (handles stale helpers).
  const lines = [
    "#!/bin/bash",
    "# aurex-publish: create/update an nginx reverse-proxy config for a slug.",
    "# Usage: aurex-publish <slug> <webroot> [backend_ip:port] [proxy-all]",
    "# Usage (unpublish): aurex-publish <slug> __remove__",
    "set -euo pipefail",
    'SLUG="$1"; WEBROOT="$2"; BACKEND="${3:-}"; PROXY_ALL="${4:-}"',
    'if [ "$WEBROOT" = "__remove__" ] || [ "$BACKEND" = "__remove__" ]; then',
    '  CONF="/etc/nginx/sites-available/aurex-${SLUG}.conf"',
    '  ENABLED="/etc/nginx/sites-enabled/aurex-${SLUG}.conf"',
    '  rm -f "$CONF" "$ENABLED"',
    '  nginx -t 2>/dev/null && systemctl reload nginx || true',
    '  echo "removed $SLUG"',
    '  exit 0',
    'fi',
    'if [ "$BACKEND" = "none" ]; then BACKEND=""; fi',
    'CONF="/etc/nginx/sites-available/aurex-${SLUG}.conf"',
    'ENABLED="/etc/nginx/sites-enabled/aurex-${SLUG}.conf"',
    "",
    "mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled",
    "",
    "# proxy-all: route every request to the backend server (SSR frameworks like Next.js).",
    'if [ "$PROXY_ALL" = "proxy-all" ] && [ -n "$BACKEND" ]; then',
    'cat > "$CONF" <<NGINX_EOF',
    "server {",
    "    listen 80;",
    "    server_name ${SLUG}." + PUBLISH_DOMAIN + ";",
    "    location / {",
    "        proxy_pass http://${BACKEND}/;",
    "        proxy_http_version 1.1;",
    '        proxy_set_header Upgrade \\$http_upgrade;',
    '        proxy_set_header Connection "upgrade";',
    '        proxy_set_header Host \\$host;',
    '        proxy_set_header X-Real-IP \\$remote_addr;',
    "    }",
    "}",
    "NGINX_EOF",
    "else",
    'cat > "$CONF" <<NGINX_EOF',
    "server {",
    "    listen 80;",
    "    server_name ${SLUG}." + PUBLISH_DOMAIN + ";",
    "    root ${WEBROOT};",
    "    index index.html;",
    "    location / {",
    "        try_files \\$uri \\$uri/ /index.html;",
    "    }",
    "NGINX_EOF",
    'if [ -n "$BACKEND" ]; then',
    'cat >> "$CONF" <<NGINX_EOF',
    "    location /api/ {",
    "        proxy_pass http://${BACKEND};",
    "        proxy_http_version 1.1;",
    '        proxy_set_header Upgrade \\$http_upgrade;',
    '        proxy_set_header Connection "upgrade";',
    '        proxy_set_header Host \\$host;',
    '        proxy_set_header X-Real-IP \\$remote_addr;',
    "    }",
    "NGINX_EOF",
    "fi",
    'cat >> "$CONF" <<NGINX_EOF',
    "}",
    "NGINX_EOF",
    "fi",
    "",
    'ln -sf "$CONF" "$ENABLED"',
    "nginx -t 2>/dev/null && systemctl reload nginx",
    "",
  ];
  const helperScript = lines.join("\n");
  let needsUpdate = false;
  if (!existsSync(NPROXY_HELPER)) {
    needsUpdate = true;
  } else {
    try {
      const existing = await readFile(NPROXY_HELPER, "utf8");
      // stale if missing proxy-all, aurex- prefix, or "none" handling
      if (existing !== helperScript) needsUpdate = true;
    } catch {
      needsUpdate = true;
    }
  }
  if (needsUpdate) {
    // Write via sudo-allowed /bin/cp (requires NOPASSWD for /bin/cp).
    // We can't write directly to /usr/local/sbin as non-root, so stage to tmp then cp with sudo.
    const tmp = path.join(os.tmpdir(), `aurex-publish.${Date.now()}.tmp`);
    try {
      await writeFile(tmp, helperScript, { mode: 0o755 });
      await runHost(["/usr/bin/sudo", "/bin/cp", tmp, NPROXY_HELPER]);
      await runHost(["/usr/bin/sudo", "/bin/chmod", "755", NPROXY_HELPER]).catch(() => {});
    } catch (e) {
      throw new Error(`nginx helper not found and could not be created: ${(e as Error).message}. Run setup manually.`);
    } finally {
      await import("node:fs/promises").then((m) => m.unlink(tmp).catch(() => {}));
    }
  }

  // 2. Ensure the cloudflare tunnel config has a catch-all.
  let cfg = "";
  try {
    cfg = await readFile(TUNNEL_CONFIG, "utf8");
  } catch {
    // Create a minimal config under lock
    cfg = await withConfigLock(async () => {
      try {
        const existing = await readFile(TUNNEL_CONFIG, "utf8");
        return existing;
      } catch {}
      const dir = TUNNEL_CONFIG.replace(/\/[^/]+$/, "");
      mkdirSync(dir, { recursive: true });
      const initial = `tunnel: ${TUNNEL_NAME}\ncredentials-file: ${_HOME}/.cloudflared/credentials.json\n\ningress:\n  - service: http_status:404\n`;
      await atomicWriteConfig(TUNNEL_CONFIG, initial);
      return initial;
    });
  }
  if (!cfg.includes("service: http_status:404")) {
    cfg += `\n  - service: http_status:404\n`;
    await withConfigLock(() => atomicWriteConfig(TUNNEL_CONFIG, cfg));
  }

  // 3. Ensure cloudflared is running.
  try {
    await runHost(["/usr/bin/sudo", "/usr/bin/systemctl", "is-active", "cloudflared"]);
  } catch {
    await runHost(["/usr/bin/sudo", "/usr/bin/systemctl", "start", "cloudflared"], { timeoutMs: 15_000 });
  }

  return { ok: true, details: "Publish infrastructure is ready" };
}

function verifyDnsPropagation(hostname: string, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let attempt = 0;
    const tick = () => {
      attempt++;
      dns.lookup(hostname, (err) => {
        if (err) {
          if (Date.now() - started >= timeoutMs) {
            reject(new Error(`DNS did not resolve within ${timeoutMs / 1000}s`));
          } else {
            setTimeout(tick, 2_000);
          }
          return;
        }
        // DNS resolved — now verify the URL is actually reachable over HTTPS.
        // Transient 5xx (502/530/503) during cloudflared restart should NOT resolve; retry until <500.
        const req = request(`https://${hostname}/`, { method: "GET", timeout: 8_000 }, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) {
            resolve();
          } else {
            if (Date.now() - started >= timeoutMs) {
              reject(new Error(`URL returned status ${res.statusCode} after ${timeoutMs / 1000}s`));
            } else {
              setTimeout(tick, 2_000);
            }
          }
        });
        req.on("error", (e) => {
          if (Date.now() - started >= timeoutMs) {
            reject(new Error(`URL not reachable after ${timeoutMs / 1000}s: ${e.message}`));
          } else {
            setTimeout(tick, 2_000);
          }
        });
        req.on("timeout", () => {
          req.destroy();
          if (Date.now() - started >= timeoutMs) {
            reject(new Error(`URL not reachable after ${timeoutMs / 1000}s: timeout`));
          } else {
            setTimeout(tick, 2_000);
          }
        });
        req.end();
      });
    };
    // initial delay 1s so cloudflared has a moment after restart before first probe
    setTimeout(tick, 1_000);
  });
}

export async function publishProject(projectId: string, userId?: string, customSlug?: string): Promise<{ url: string }> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("project not found");

  const isRepublish = project.publishedUrl != null && project.subdomain != null;

  // Change detection: only republish if there are new completed runs since last publish.
  if (isRepublish) {
    const latestRun = await prisma.agentRun.findFirst({
      where: { projectId, status: "completed" },
      orderBy: { completedAt: "desc" },
      select: { id: true, completedAt: true },
    });
    if (!latestRun || latestRun.id === project.lastPublishedRunId) {
      throw new Error("no_changes");
    }
  }

  const progress = async (status: string, pct: number) => {
    await prisma.project.update({ where: { id: projectId }, data: { publishStatus: status, publishProgress: pct } }).catch(() => {});
  };

  await progress("Preparing…", 5);

  // Ensure publish infrastructure (nginx helper, tunnel, etc.) is set up.
  await ensurePublishSetup();

  const workspace = await resolveProjectWorkspace(userId, projectId);
  if (!workspace) throw new Error("project has no workspace");
  const dir =
    workspace.projectId != null
      ? workspace.path ?? projectWorkspacePath(project.name)
      : workspaceRunDirectory(workspace.path, true, project.name);

  const container = workspaceContainerName(workspace.id);
  const state = await containerState(container);
  if (state === "missing") throw new Error("workspace container no longer exists");
  if (state === "stopped") await startWorkspace(container);

  // Lock subdomain after first publish — ignore customSlug on republish.
  if (!PUBLISH_DOMAIN) throw new Error("publish domain not configured — set AUREX_PUBLISH_DOMAIN in .env or run installer with --publish-domain");
  const slug = isRepublish ? project.subdomain! : (customSlug ? slugify(customSlug) : project.subdomain ?? slugify(project.name));
  const hostname = `${slug}.${PUBLISH_DOMAIN}`;
  let backendPort = getBackendPort(slug);
  // Auto-fix: if backend/.env specifies PORT, use it (e.g. hospital uses 4001 not hash 4554)
  try {
    const backendEnvRaw = await execLong(container, ["sh", "-c", `cat "$1/backend/.env" 2>/dev/null || cat "$1/server/.env" 2>/dev/null || echo ""`, "sh", dir]);
    const m = backendEnvRaw.match(/^PORT\s*=\s*(\d+)/m);
    if (m) {
      const p = parseInt(m[1], 10);
      if (p > 0 && p < 65535) backendPort = p;
    }
  } catch {}

  // 1. Build / install (framework-aware: detect stack, use correct PM + build command).
  await progress("Building frontend…", 15);
  const hasPackageJson = (await execLong(container, ["sh", "-c", `[ -f "$1/package.json" ] && echo yes || echo no`, "sh", dir])).trim();
  const hasPythonReqs = (await execLong(container, ["sh", "-c",
    `for f in requirements.txt pyproject.toml setup.py Pipfile; do [ -f "$1/$f" ] && echo "$f"; done || true`,
    "sh", dir,
  ])).trim() !== "";
  const hasFrontendPkg = hasPackageJson !== "yes" ? (await execLong(container, ["sh", "-c", `[ -f "$1/frontend/package.json" ] && echo yes || echo no`, "sh", dir])).trim() === "yes" : false;
  const hasBackendPkg = (await execLong(container, ["sh", "-c", `[ -f "$1/backend/package.json" ] && echo yes || echo no`, "sh", dir])).trim() === "yes";
  let fw: FrameworkInfo | null = null;

  if (hasPackageJson === "yes") {
    fw = await detectFramework(container, dir);
    await progress(`Building (${fw.name})…`, 15);

    const hasModules = (await execLong(container, ["sh", "-c", `[ -d "$1/node_modules" ] && echo yes || echo no`, "sh", dir])).trim();
    if (hasModules !== "yes") {
      await execLong(container, ["sh", "-c", `cd "$1" && ${fw.installCmd}`, "sh", dir], 20 * 60 * 1000);
    }

    let buildOutput = "";
    try {
      const buildCmd = fw.buildCommand.includes("npm") ? fw.buildCommand.replace("npm", "npm --loglevel=error") : fw.buildCommand;
      buildOutput = await execLong(container, ["sh", "-c", `cd "$1" && ${buildCmd} 2>&1`, "sh", dir], 20 * 60 * 1000);
    } catch (e) {
      const raw = (e as Error).message;
      if (raw.includes("npm warn config production")) {
        try {
          buildOutput = await execLong(container, ["sh", "-c", `cd "$1" && ${fw.buildCommand} 2>&1`, "sh", dir], 20 * 60 * 1000);
        } catch (e2) {
          const msg2 = `build failed: ${(e2 as Error).message.slice(-800)}`;
          await prisma.project.update({ where: { id: projectId }, data: { publishStatus: msg2.slice(0, 200), publishProgress: 0 } }).catch(() => {});
          throw new Error(msg2);
        }
      } else {
        const msg = `build failed: ${raw.slice(-800)}`;
        // Update DB so frontend doesn't stay stuck at 15% spinning - surface error immediately
        await prisma.project.update({ where: { id: projectId }, data: { publishStatus: msg.slice(0, 200), publishProgress: 0 } }).catch(() => {});
        throw new Error(msg);
      }
    }
  } else if (hasFrontendPkg) {
    // Monorepo: frontend/ contains the SPA, backend/ may contain API
    const frontendDir = `${dir}/frontend`;
    fw = await detectFramework(container, frontendDir);
    await progress(`Building frontend (${fw.name})…`, 15);
    const hasModules = (await execLong(container, ["sh", "-c", `[ -d "$1/node_modules" ] && echo yes || echo no`, "sh", frontendDir])).trim();
    if (hasModules !== "yes") {
      await execLong(container, ["sh", "-c", `cd "$1" && ${fw.installCmd}`, "sh", frontendDir], 20 * 60 * 1000);
    }
    try {
      // Suppress npm warn config production noise that causes false failures
      const buildCmd = fw.buildCommand.includes("npm") ? fw.buildCommand.replace("npm", "npm --loglevel=error") : fw.buildCommand;
      await execLong(container, ["sh", "-c", `cd "$1" && ${buildCmd} 2>&1`, "sh", frontendDir], 20 * 60 * 1000);
    } catch (e) {
      const raw = (e as Error).message;
      // If it's just the npm warn, ignore and try without loglevel
      if (raw.includes("npm warn config production")) {
        try {
          await execLong(container, ["sh", "-c", `cd "$1" && ${fw.buildCommand} 2>&1`, "sh", frontendDir], 20 * 60 * 1000);
          // Success on retry, don't throw
        } catch (e2) {
          const msg = `frontend build failed: ${(e2 as Error).message.slice(-800)}`;
          await prisma.project.update({ where: { id: projectId }, data: { publishStatus: msg.slice(0, 200), publishProgress: 0 } }).catch(() => {});
          throw new Error(msg);
        }
      } else {
        const msg = `frontend build failed: ${raw.slice(-800)}`;
        await prisma.project.update({ where: { id: projectId }, data: { publishStatus: msg.slice(0, 200), publishProgress: 0 } }).catch(() => {});
        throw new Error(msg);
      }
    }
    // Also build backend if present (for completeness, even if backend runs separately)
    if (hasBackendPkg) {
      const backendDir = `${dir}/backend`;
      try {
        const backendHasModules = (await execLong(container, ["sh", "-c", `[ -d "$1/node_modules" ] && echo yes || echo no`, "sh", backendDir])).trim();
        if (backendHasModules !== "yes") {
          const bf = await detectFramework(container, backendDir).catch(() => null);
          const installCmd = bf?.installCmd ?? "npm install --no-audit --no-fund";
          await execLong(container, ["sh", "-c", `cd "$1" && ${installCmd}`, "sh", backendDir], 20 * 60 * 1000);
        }
        // Build backend (tsc) if it has a build script
        const pkgRaw = await execLong(container, ["sh", "-c", `cat "$1/package.json" 2>/dev/null || echo '{}'`, "sh", backendDir]);
        const pkg = JSON.parse(pkgRaw || "{}") as { scripts?: Record<string, string> };
        if (pkg.scripts?.build) {
          await progress("Building backend…", 20);
          await execLong(container, ["sh", "-c", `cd "$1" && npm run build 2>&1`, "sh", backendDir], 20 * 60 * 1000);
        }
      } catch {}
    }
  } else if (hasPythonReqs) {
    fw = await detectPythonFramework(container, dir, backendPort);
    if (!fw) throw new Error("python project detected but framework could not be identified");
    await progress(`Installing (${fw.name})…`, 15);

    await execLong(container, ["sh", "-c", `cd "$1" && ${fw.installCmd}`, "sh", dir], 20 * 60 * 1000);

    if (fw.buildCommand) {
      await progress("Collecting static assets…", 25);
      try {
        await execLong(container, ["sh", "-c", `cd "$1" && ${fw.buildCommand} 2>&1`, "sh", dir], 20 * 60 * 1000);
      } catch (e) {
        const msg = `build failed: ${(e as Error).message.slice(-800)}`;
        await prisma.project.update({ where: { id: projectId }, data: { publishStatus: msg.slice(0, 200), publishProgress: 0 } }).catch(() => {});
        throw new Error(msg);
      }
    }
  }

  // 2. Locate the built frontend directory.
  //
  // Heuristic: a valid build output has index.html but NO src/ directory next to
  // it (src/ means it's the source, not the built output).  We also prefer
  // directories that contain an assets/ folder (hashed Vite/CRA bundles).
  //
  // Search order: standard build dirs first, then subdirectories, then root as
  // a last resort — each candidate is validated before acceptance.
  await progress("Locating build output…", 35);

  // Framework-detected output directories are tried first, then the standard
  // set of well-known build dirs.
  const knownPaths = [
    ...(fw?.outputDirs ?? []).map((d) => `"$dir/${d}"`),
    `"$dir/client/dist"`,
    `"$dir/dist"`,
    `"$dir/build"`,
    `"$dir/out"`,
    `"$dir/public"`,
    `"$dir/www"`,
    `"$dir/frontend/dist"`,
  ];

  const locateScript = [
    `dir="$1"`,
    // Accept a dir if it has index.html and is NOT a source dir.
    `accept() {`,
    `  [ -f "$1/index.html" ] || return 1`,
    `  [ -d "$1/src" ] && return 1`,
    `  echo "$1"; exit 0`,
    `}`,
    // 1. Known build output paths at root (framework-detected first).
    ...knownPaths.map((p) => `accept ${p} 2>/dev/null`),
    // 2. Subdirectories — check the subdir itself, its dist/build/out dirs,
    //    and one more level deep for monorepo layouts.
    `for d in "$dir"/*/; do`,
    `  [ -d "$d" ] || continue`,
    `  case "$d" in */node_modules/*|*/.git/*) continue;; esac`,
    `  accept "$d"              2>/dev/null`,
    `  accept "$d/dist"         2>/dev/null`,
    `  accept "$d/build"        2>/dev/null`,
    `  accept "$d/out"          2>/dev/null`,
    `  accept "$d/public"       2>/dev/null`,
    `  accept "$d/client/dist"  2>/dev/null`,
    `  accept "$d/frontend/dist" 2>/dev/null`,
    `  for sd in "$d"/*/; do`,
    `    [ -d "$sd" ] || continue`,
    `    case "$sd" in */node_modules/*|*/.git/*) continue;; esac`,
    `    accept "$sd"           2>/dev/null`,
    `    accept "$sd/dist"      2>/dev/null`,
    `    accept "$sd/build"     2>/dev/null`,
    `    accept "$sd/out"       2>/dev/null`,
    `  done`,
    `done`,
    // 3. Root itself — only if there's no src/ (flat static project).
    `accept "$dir" 2>/dev/null`,
    // 4. Last resort: find any index.html (skip node_modules/.git).
    `found=$(find "$dir" -name index.html -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' 2>/dev/null | head -1)`,
    `[ -n "$found" ] && echo "$(dirname "$found")" || echo none`,
  ].join("\n");

  const staticRootRaw = await execLong(container, ["sh", "-c", locateScript, "sh", dir]);
  const staticRoot = staticRootRaw.trim();
  // For SSR frameworks (Next.js, Nuxt, SvelteKit) the server renders HTML so a
  // static index.html may not exist — that's fine, the server handles it.
  if (staticRoot === "none" && !fw?.needsServer) {
    throw new Error("no built frontend found (index.html) after build");
  }

   // 3. Backend: reuse an already-running server on per-slug port, else start it.
  await progress("Starting backend server…", 45);
  let backend = "none";
  // Detect a backend: server/, backend/, api/, .next/, or Python entry points. Auto-fix: monorepo backend/ detection for hospital.
  const hasServerDir = (await execLong(container, ["sh", "-c",
    `{ [ -d "$1/server" ] || [ -d "$1/backend" ] || [ -d "$1/api" ] || [ -d "$1/.next" ] || [ -f "$1/manage.py" ] || [ -f "$1/app.py" ] || [ -f "$1/main.py" ] || [ -f "$1/backend/package.json" ]; } && echo yes || echo no`,
    "sh", dir,
  ])).trim() === "yes";

  // Start a server if the framework requires one (SSR/Python) or a server dir exists.
  if (fw?.needsServer || hasServerDir) {
    // Auto-fix: monorepo backend/ handling — if backend subdir exists, use it as start dir
    let backendDir = dir;
    const hasBackendSubdir = (await execLong(container, ["sh", "-c", `[ -f "$1/backend/package.json" ] && echo yes || echo no`, "sh", dir])).trim() === "yes";
    if (hasBackendSubdir) backendDir = `${dir}/backend`;
    // Check if backend is already running externally (e.g. hospital-api PM2 on host 4001)
    const hostPortOpen = (await execLong(container, ["sh", "-c", `ss -tln 2>/dev/null | grep -q ":${backendPort} " && echo yes || echo no`, "sh", dir]).catch(() => "no")).trim() === "yes";
    if (!(await backendHealthy(container, backendPort)) && hostPortOpen) {
      // External backend already listening (e.g. hospital-api), skip start and use host IP
      backend = `127.0.0.1:${backendPort}`;
    } else if (!(await backendHealthy(container, backendPort))) {
      const pidFile = `${AGENT_HOME}/logs/${slug}-api.pid`;
      const logFile = `${AGENT_HOME}/logs/${slug}-api.log`;
      await execLong(container, ["sh", "-c", `kill -- -$(cat "$1") 2>/dev/null; rm -f "$1"; true`, "sh", pidFile]).catch(() => undefined);
      // Use the framework's start command if detected.  For hybrid projects
      // (JS frontend + Python backend) try to detect a Python start command.
      // Pass per-slug port so Python frameworks bind to correct port.
      let startCmd = fw?.startCommand || "";
      if (!startCmd && hasBackendSubdir) {
        // Try to detect framework from backend subdir
        const bf = await detectFramework(container, backendDir).catch(() => null);
        if (bf) startCmd = bf.startCommand;
      }
      if (!startCmd) {
        const pyFw = await detectPythonFramework(container, hasBackendSubdir ? backendDir : dir, backendPort);
        startCmd = pyFw?.startCommand || "npm run start";
      } else if (fw && fw.lang === "python") {
        // Rewrite any hardcoded BACKEND_PORT in python startCommand to per-slug port
        startCmd = startCmd.replace(new RegExp(String(BACKEND_PORT), "g"), String(backendPort));
      }
      await execDetach(container, [
        "sh",
        "-c",
        `cd "$1" && { setsid sh -c 'PORT=${backendPort} HOST=0.0.0.0 ${startCmd}' >> "$2" 2>&1 & echo $! > "$3"; }`,
        "sh",
        backendDir,
        logFile,
        pidFile,
      ]);
      for (let i = 0; i < 30; i++) {
        if (await backendHealthy(container, backendPort)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (await backendHealthy(container, backendPort) || hostPortOpen) {
      let ip = "127.0.0.1";
      try {
        const dockerIp = (await runHost(["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container])).trim();
        console.log(`[publish] docker inspect ip for ${container}: "${dockerIp}" (valid=${/^\d+\.\d+\.\d+\.\d+$/.test(dockerIp)})`);
        if (dockerIp && /^\d+\.\d+\.\d+\.\d+$/.test(dockerIp)) ip = dockerIp;
        else console.log(`[publish] docker IP invalid or empty, keeping ${ip}`);
      } catch (e) {
        console.log(`[publish] docker inspect failed for ${container}: ${(e as Error).message}, using ${ip}`);
      }
      backend = `${ip}:${backendPort}`;
      console.log(`[publish] backend set to ${backend} (hostPortOpen=${hostPortOpen}, backendHealthy=${await backendHealthy(container, backendPort)})`);
      // In host mode, docker inspect fails or returns invalid IP (exited container), use host IP
      if (!backend || backend.startsWith(":") || backend.includes("invalid")) backend = `127.0.0.1:${backendPort}`;
    }
  }

  // 4. Backup existing site before overwriting (republish only).
  if (isRepublish) {
    await progress("Backing up current site…", 55);
    await backupPublishedSite(slug);
  }

  // 5. Copy the static build into the nginx webroot (skip for SSR-only).
  await progress("Copying to webroot…", 60);
  const webroot = `${WEBROOT}/${slug}`;
  await runHost(["mkdir", "-p", webroot]);
  if (staticRoot && staticRoot !== "none") {
    const isHostMode = process.env.AUREX_HOST_MODE === "true";
    if (isHostMode) {
      const raw = staticRoot.trim();
      let effectiveRoot: string;
      if (raw.startsWith("/workspace")) {
        const hr = process.env.AUREX_HOST_ROOT;
        const hostRoot = (!hr || hr === "/") ? `${_HOME}/workspace` : hr.replace(/\/$/, "");
        effectiveRoot = raw.replace("/workspace", hostRoot);
      } else {
        effectiveRoot = raw;
      }
      try {
        await runHost(["bash", "-c", `rm -rf "${webroot}"/* 2>/dev/null; mkdir -p "${webroot}"; cp -a "${effectiveRoot}/." "${webroot}/"`]);
      } catch (e) {
        await runHost(["bash", "-c", `tar cf - -C "${effectiveRoot}" . | tar xf - -C "${webroot}"`]);
      }
      await runHost(["chmod", "-R", "a+rX", webroot]);
    } else {
      const tar = execStream(container, ["sh", "-c", `cd "$1" && tar cf - --ignore-failed-read .`, "sh", staticRoot.trim()]);
      const extract = spawn("tar", ["xf", "-", "-C", webroot], { stdio: ["pipe", "pipe", "pipe"] });
      let tarStderr = "";
      let extractStderr = "";
      tar.stderr.on("data", (c: Buffer) => (tarStderr += c.toString()));
      extract.stderr.on("data", (c: Buffer) => (extractStderr += c.toString()));
      tar.stdout.pipe(extract.stdin);
      const extractDone = new Promise<void>((resolve, reject) => {
        extract.on("error", reject);
        extract.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar extract failed with code ${code}: ${extractStderr.slice(0, 500)}`))));
      });
      const tarDone = new Promise<void>((resolve, reject) => {
        tar.child.on("error", reject);
        tar.child.on("close", (code) => {
          if (code === 0 || code === 1) resolve();
          else reject(new Error(`docker exec tar failed with code ${code}: ${tarStderr.slice(0, 500)}`));
        });
      });
      await Promise.all([extractDone, tarDone]);
      await runHost(["chmod", "-R", "a+rX", webroot]);
    }
  }

  // 6. nginx site via the root helper.  For SSR frameworks, proxy-all routes
  //    every request to the backend server instead of serving static files.
  await progress("Configuring nginx…", 75);
  try {
    const proxyAll = fw?.needsServer && backend !== "none" ? "proxy-all" : "";
    const nginxArgs = [slug, webroot, backend, ...(proxyAll ? [proxyAll] : [])].filter((a) => a);
    console.log(`[publish] nginx helper args: ${NPROXY_HELPER} ${nginxArgs.join(" ")} (backend=${backend}, fw=${fw?.name}, needsServer=${fw?.needsServer}, hasServerDir=${hasServerDir})`);
    await runHost(["/usr/bin/sudo", NPROXY_HELPER, ...nginxArgs]);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[publish] nginx helper failed for ${slug}: ${msg} (args: ${NPROXY_HELPER} ${[slug, webroot, backend].join(" ")})`);
    throw new Error(
      `nginx helper not set up: ${msg}. Run the one-time setup (see instructions) before publishing.`,
    );
  }

  // 7. Cloudflare tunnel ingress (restart the tunnel so the new hostname is served).
  await progress("Setting up Cloudflare tunnel…", 85);
  const { readFile } = await import("node:fs/promises");
  let cfg = await readFile(TUNNEL_CONFIG, "utf8");
  let configChanged = !cfg.includes(hostname);
  if (configChanged) {
    await withConfigLock(async () => {
      const fresh = await readFile(TUNNEL_CONFIG, "utf8").catch(() => cfg);
      if (fresh.includes(hostname)) { configChanged = false; return; }
      const entry = `  - hostname: ${hostname}\n    service: http://127.0.0.1:80\n\n`;
      const marker = "  - service: http_status:404";
      let next = fresh;
      if (next.includes(marker)) next = next.replace(marker, `${entry}${marker}`);
      else next += `\n${entry}`;
      await atomicWriteConfig(TUNNEL_CONFIG, next);
      cfg = next;
    });
  }
  if (configChanged) {
    // Restart cloudflared in the background so the tunnel picks up the new hostname.
    // We deliberately do NOT await the full restart — it can take 30+ s (systemd waits
    // for active SSE/QUIC connections to drain), and blocking would cause the API
    // response to be routed through a dead tunnel, resulting in Cloudflare 530s.
    const restart = spawn("/usr/bin/sudo", ["/usr/bin/systemctl", "restart", "cloudflared"], {
      detached: true,
      stdio: "ignore",
    });
    restart.unref();
    // Give systemd a moment to begin the restart before we proceed.
    await new Promise((r) => setTimeout(r, 2000));
  }

   // 8. DNS CNAME record pointing at the tunnel.
   await progress("Creating DNS record…", 92);
   const republish = project.publishedUrl != null;
   const dnsArgs = ["cloudflared", "tunnel", "route", "dns"];
   if (republish) dnsArgs.push("--overwrite-dns");
   dnsArgs.push(TUNNEL_NAME, hostname);
   await runHost(dnsArgs, { cwd: `${_HOME}/.cloudflared`, timeoutMs: 60_000 }).catch((e) => {
      throw new Error(`failed to create DNS record: ${(e as Error).message}`);
    });

    // 8b. Wait for DNS to propagate and the hostname to resolve + be reachable.
    await progress("Verifying DNS…", 95);
    await verifyDnsPropagation(hostname);

     // 8c. Warm-up before exposing preview URL - lets Cloudflare + nginx settle
     // so the first preview load never 502s. Reduced from 30s and made interruptible via health check.
     await progress("Warming up preview…", 96);
     const warmupMs = Number(process.env.PUBLISH_WARMUP_MS ?? 8000);
     const warmupStart = Date.now();
     while (Date.now() - warmupStart < warmupMs) {
       const deadline = Math.min(5000, warmupMs - (Date.now() - warmupStart));
       if (deadline <= 0) break;
       await new Promise((r) => setTimeout(r, deadline));
       // early exit if already healthy
       try {
         const { request: httpsReq } = await import("node:https");
         const ok = await new Promise<boolean>((resolve) => {
           const req = httpsReq(`https://${hostname}/`, { method: "HEAD", timeout: 4000 }, (res) => {
             res.resume(); resolve(!!res.statusCode && res.statusCode < 500);
           });
           req.on("error", () => resolve(false));
           req.on("timeout", () => { req.destroy(); resolve(false); });
           req.end();
         });
         if (ok) break;
       } catch {}
     }

    // 9. Record it.
   await progress("Finalizing…", 98);
  const url = `https://${hostname}`;
  const latestCompletedRun = await prisma.agentRun.findFirst({
    where: { projectId, status: "completed" },
    orderBy: { completedAt: "desc" },
    select: { id: true },
  });
  await prisma.project.update({
    where: { id: projectId },
    data: {
      publishedUrl: url,
      publishedAt: new Date(),
      subdomain: slug,
      publishStatus: "done",
      publishProgress: 100,
      lastPublishedRunId: latestCompletedRun?.id ?? null,
    },
  });
  return { url };
}

/** Remove a published project's static site from the host webroot. */
export async function removePublishedSite(projectName: string): Promise<void> {
  const slug = slugify(projectName);
  await runHost(["rm", "-rf", `${WEBROOT}/${slug}`]).catch(() => undefined);
}

/**
 * Create a timestamped backup of a published site before republishing.
 * Keeps at most 3 backups; older ones are pruned.
 */
async function backupPublishedSite(slug: string): Promise<string | null> {
  const siteDir = `${WEBROOT}/${slug}`;
  const { statSync } = await import("node:fs");
  try {
    statSync(siteDir);
  } catch {
    return null; // nothing to backup
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = `${siteDir}.backup.${ts}`;
  await runHost(["cp", "-r", siteDir, backupDir]);
  // Prune: keep only the 3 most recent backups.
  try {
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(WEBROOT)
      .filter((e) => e.startsWith(`${slug}.backup.`))
      .sort()
      .reverse();
    for (const old of entries.slice(3)) {
      await runHost(["rm", "-rf", `${WEBROOT}/${old}`]);
    }
  } catch { /* best effort */ }
  return backupDir;
}

/** Restore a published site from its most recent backup. */
export async function rollbackPublishedSite(slug: string): Promise<{ restored: boolean; backup?: string }> {
  const { readdirSync } = await import("node:fs");
  const backups = readdirSync(WEBROOT)
    .filter((e) => e.startsWith(`${slug}.backup.`))
    .sort()
    .reverse();
  if (backups.length === 0) return { restored: false };
  const latest = backups[0];
  const siteDir = `${WEBROOT}/${slug}`;
  // Remove current site and replace with backup.
  await runHost(["rm", "-rf", siteDir]);
  await runHost(["cp", "-r", `${WEBROOT}/${latest}`, siteDir]);
  return { restored: true, backup: latest };
}

/** Unpublish a project - takes down URL, clears DB, stops backend, removes nginx + webroot */
export async function unpublishProject(projectId: string, userId?: string): Promise<{ ok: boolean; slug?: string }> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("project not found");
  if (!project.publishedUrl && !project.subdomain) throw new Error("not_published");

  const slug = project.subdomain ?? slugify(project.name);
  const hostname = `${slug}.${PUBLISH_DOMAIN}`;
  const webroot = `${WEBROOT}/${slug}`;

  // 1. Stop per-slug backend if running
  try {
    const workspace = await resolveProjectWorkspace(userId, projectId);
    if (workspace) {
      const container = workspaceContainerName(workspace.id);
      const pidFile = `${AGENT_HOME}/logs/${slug}-api.pid`;
      await execLong(container, ["sh", "-c", `kill -- -$(cat "$1") 2>/dev/null; rm -f "$1"; true`, "sh", pidFile]).catch(() => undefined);
      // Also try to kill process on its per-slug port
      const port = getBackendPort(slug);
      await execLong(container, ["sh", "-c", `fuser -k ${port}/tcp 2>/dev/null; true`]).catch(() => undefined);
    }
  } catch {}

  // 2. Remove nginx via helper (uses sudo)
  try {
    await runHost(["/usr/bin/sudo", NPROXY_HELPER, slug, "__remove__"]);
  } catch (e) {
    // fallback: try direct rm via helper already handles reload, ignore error but log
    console.warn(`[unpublish] nginx remove failed for ${slug}:`, (e as Error).message);
  }

  // 3. Remove webroot + backups (best effort)
  await runHost(["rm", "-rf", webroot]).catch(() => undefined);
  // prune backups for this slug
  try {
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(WEBROOT).filter((e) => e.startsWith(`${slug}.backup.`));
    for (const ent of entries) await runHost(["rm", "-rf", `${WEBROOT}/${ent}`]).catch(() => undefined);
  } catch {}

  // 4. Remove cloudflared ingress for this hostname (under lock to avoid race)
  try {
    await withConfigLock(async () => {
      const { readFile } = await import("node:fs/promises");
      let cfg = await readFile(TUNNEL_CONFIG, "utf8");
      const entry = `  - hostname: ${hostname}\n    service: http://127.0.0.1:80\n`;
      let changed = false;
      if (cfg.includes(entry)) {
        cfg = cfg.replace(entry, "");
        changed = true;
      }
      const entry2 = `  - hostname: ${hostname}\n    service: http://127.0.0.1:80\n\n`;
      if (cfg.includes(entry2)) {
        cfg = cfg.replace(entry2, "");
        changed = true;
      }
      if (changed) {
        await atomicWriteConfig(TUNNEL_CONFIG, cfg);
        const { spawn } = await import("node:child_process");
        const restart = spawn("/usr/bin/sudo", ["/usr/bin/systemctl", "restart", "cloudflared"], { detached: true, stdio: "ignore" });
        restart.unref();
        await new Promise((r) => setTimeout(r, 2000));
      }
    });
  } catch (e) {
    console.warn(`[unpublish] cloudflared config remove failed for ${hostname}:`, (e as Error).message);
  }

  // 5. Clear DB - allows fresh publish (restarts publishing process, no no_changes block)
  await prisma.project.update({
    where: { id: projectId },
    data: {
      publishedUrl: null,
      publishedAt: null,
      subdomain: null,
      publishStatus: null,
      publishProgress: null,
      lastPublishedRunId: null,
    },
  });

  return { ok: true, slug };
}
