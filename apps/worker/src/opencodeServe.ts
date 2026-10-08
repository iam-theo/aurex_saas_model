import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { execCapture, execDetach, execWithStdin } from "@aurex/docker";
import type { PromptPart } from "./ingest.js";

const HOME_DIR = process.env.HOME ?? homedir() ?? "/home/aurex";
const HOST_MODE = process.env.AUREX_HOST_MODE === "true" || process.env.AUREX_EXEC_MODE === "host";
const _rawRoot = process.env.AUREX_HOST_ROOT;
const HOST_ROOT = (() => {
  if (!_rawRoot || _rawRoot === "/") {
    if (HOST_MODE) {
      return `${HOME_DIR}/workspace`;
    }
    return "/";
  }
  return _rawRoot;
})();
export function toHostDir(dir: string): string {
  if (!HOST_MODE) return dir;
  if (dir.startsWith("/workspace")) {
    const rel = dir.slice("/workspace".length) || "/";
    if (HOST_ROOT === `${HOME_DIR}/workspace`) {
      return join(HOST_ROOT, rel === "/" ? "" : rel.slice(1));
    }
    if (HOST_ROOT === "/") return rel === "/" ? "/" : rel;
    return join(HOST_ROOT, rel);
  }
  return dir;
}

function resolveOpencodeBinary(): string {
  const candidates = [
    process.env.OPENCODE_BIN,
    join(HOME_DIR, ".npm-global/bin/opencode"),
    join(HOME_DIR, ".bun/bin/opencode"),
    "/usr/local/bin/opencode",
    "opencode",
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (p === "opencode") return p;
    try {
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      if (existsSync(p)) return p;
    } catch {}
  }
  return "opencode";
}
/**
 * Client for a persistent `opencode serve` instance.
 * In container mode calls go through `docker exec`; in HOST_MODE they run directly on host.
 */

export const SERVE_PORT = 4096;
export const SERVE_BASE = `http://localhost:${SERVE_PORT}`;

export interface ServeEvent {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function props(evt: ServeEvent): Record<string, unknown> {
  if (evt.properties && typeof evt.properties === "object") return evt.properties;
  if (evt.data && typeof evt.data === "object") return evt.data;
  return {};
}

export function eventSessionID(evt: ServeEvent): string | undefined {
  const p = props(evt);
  const v = p.sessionID ?? (p as { data?: Record<string, unknown> }).data?.sessionID;
  return typeof v === "string" ? v : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function isServeHealthy(containerName: string): Promise<boolean> {
  if (HOST_MODE) {
    try {
      const res = await fetch(`${SERVE_BASE}/global/health`, { signal: AbortSignal.timeout(3000) });
      const txt = await res.text();
      return txt.includes("healthy");
    } catch { return false; }
  }
  try {
    const out = await execCapture(containerName, [
      "sh",
      "-c",
      `curl -s --max-time 3 ${SERVE_BASE}/global/health`,
    ]);
    return out.includes("healthy");
  } catch {
    return false;
  }
}

/**
 * Install a per-project env injector into the container. Every bash command the
 * agent runs sources the project's own `.env` (present in the project directory
 * written by the env vars page), so credentials edited in the UI are available
 * at runtime. Non-interactive bash picks it up via BASH_ENV; interactive shells
 * via .bashrc.
 */
async function installRuntimeEnv(containerName: string): Promise<void> {
  if (HOST_MODE) return; // host already has env
  await execDetach(containerName, [
    "sh",
    "-c",
    [
      `install -d /home/agent`,
      `cat > /home/agent/.aurex-env <<'AUREXEOF'`,
      `[ -f "$PWD/.env" ] && { set -a; . "$PWD/.env" 2>/dev/null; set +a; }`,
      `AUREXEOF`,
      `grep -q 'AUREX_RUNTIME_ENV' /home/agent/.bashrc 2>/dev/null || printf '\\n# AUREX_RUNTIME_ENV\\n[ -f /home/agent/.aurex-env ] && . /home/agent/.aurex-env\\n' >> /home/agent/.bashrc`,
    ].join("\n"),
  ]);
}

/** Ensure `opencode serve` is running inside the container, starting it if needed. */
export async function ensureServeRunning(containerName: string): Promise<void> {
  if (await isServeHealthy(containerName)) return;
  if (HOST_MODE) {
    const env: Record<string,string> = {};
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    // ensure config dir on host
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const cfgDir = join(homedir(), ".config", "opencode");
    try { mkdirSync(cfgDir, { recursive: true }); } catch {}
    const cfgPath = join(cfgDir, "opencode.json");
    if (!existsSync(cfgPath)) {
      try { writeFileSync(cfgPath, JSON.stringify({ $schema:"https://opencode.ai/config.json" }, null, 2)); } catch {}
    }
    // spawn opencode serve detached on host — use absolute binary path (PM2 PATH lacks .npm-global)
    const { spawn } = await import("node:child_process");
    const logsDir = join(homedir(), ".aurex-logs");
    try { mkdirSync(logsDir, { recursive:true }); } catch {}
    const logFile = join(logsDir, "serve.log");
    const opencodeBin = resolveOpencodeBinary();
    const child = spawn("sh", ["-c", `nohup "${opencodeBin}" serve --hostname 0.0.0.0 --port ${SERVE_PORT} >> "${logFile}" 2>&1 & echo started`], { stdio:"ignore", detached:true, env: { ...process.env, ...env } });
    child.unref();
    for (let i=0;i<30;i++) { if (await isServeHealthy(containerName)) return; await sleep(1000); }
    throw new Error("opencode serve did not become healthy on host");
  }
  await installRuntimeEnv(containerName);
  const envExports = [
    "export HOME=/home/agent;",
    "export BASH_ENV=/home/agent/.aurex-env;",
  ];
  if (process.env.OPENAI_API_KEY) envExports.push(`export OPENAI_API_KEY=${process.env.OPENAI_API_KEY};`);
  if (process.env.ANTHROPIC_API_KEY)
    envExports.push(`export ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY};`);

  await execDetach(containerName, [
    "sh",
    "-c",
    `mkdir -p /home/agent/.config/opencode && cat > /home/agent/.config/opencode/opencode.json <<'AUREXCONFIG'
{
  "$schema": "https://opencode.ai/config.json"
}
AUREXCONFIG`,
  ]);

  await execDetach(containerName, [
    "sh",
    "-c",
    `${envExports.join(" ")} mkdir -p /home/agent/logs && nohup opencode serve --hostname 0.0.0.0 --port ${SERVE_PORT} >> /home/agent/logs/serve.log 2>&1 & echo started`,
  ]);
  for (let i = 0; i < 30; i++) {
    if (await isServeHealthy(containerName)) return;
    await sleep(1000);
  }
  throw new Error("opencode serve did not become healthy inside the workspace container");
}

/** Create a new opencode session in the given project directory. */
export async function createSession(containerName: string, directory: string): Promise<{ id: string }> {
  const dir = HOST_MODE ? toHostDir(directory) : directory;
  if (HOST_MODE) {
    const res = await fetch(`${SERVE_BASE}/session?directory=${encodeURIComponent(dir)}`, { method:"POST" });
    const body = await res.text();
    let parsed: any={}; try{ parsed=JSON.parse(body)}catch{}
    if (!res.ok) throw new Error(`${res.status} createSession failed: ${parsed.error||parsed.message||body.slice(0,800)}`);
    if (parsed.error) throw new Error(String(parsed.error).slice(0,1000));
    if (!parsed.id) throw new Error(`unexpected createSession response: ${body.slice(0,500)}`);
    return parsed;
  }
  const out = await execCapture(containerName, [
    "sh",
    "-c",
    `curl -s --max-time 15 -w "\n%{http_code}" -X POST "${SERVE_BASE}/session?directory=${encodeURIComponent(dir)}"`,
  ]);
  const nl = out.lastIndexOf("\n");
  const body = nl !== -1 ? out.slice(0, nl) : out;
  const code = nl !== -1 ? out.slice(nl + 1).trim() : "200";
  let parsed: { id?: string; error?: unknown; message?: string } = {};
  try { parsed = JSON.parse(body) as typeof parsed; } catch {}
  if (code !== "200" && code !== "201") {
    const msg = typeof parsed.error === "string" ? parsed.error : (typeof parsed.message === "string" ? parsed.message : body.slice(0, 800));
    throw new Error(`${code} createSession failed: ${msg}`);
  }
  if (parsed.error) throw new Error(String(parsed.error).slice(0, 1000));
  const ok = parsed as { id: string };
  if (!ok.id) throw new Error(`unexpected createSession response: ${body.slice(0, 500)}`);
  return ok;
}

export function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.lastIndexOf("/");
  if (slash <= 0) return { providerID: "opencode", modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export async function sendSessionMessage(
  containerName: string,
  sessionId: string,
  parts: PromptPart[],
  model: string,
): Promise<void> {
  const { providerID, modelID } = splitModel(model);
  const body = JSON.stringify({ parts, model: { providerID, modelID } });
  if (HOST_MODE) {
    const res = await fetch(`${SERVE_BASE}/session/${sessionId}/prompt_async`, { method:"POST", headers:{ "Content-Type":"application/json"}, body });
    const txt = await res.text();
    if (!res.ok) {
      let p:any={}; try{ p=JSON.parse(txt)}catch{}
      throw new Error(`${res.status} sendSessionMessage failed: ${p.error||p.message||txt.slice(0,1000)}`);
    }
    try { const j=JSON.parse(txt); if(j.error) throw new Error(String(j.error).slice(0,1000));} catch(e){ if(e instanceof Error && e.message.includes("429")) throw e; }
    return;
  }
  const out = await execWithStdin(
    containerName,
    [
      "sh",
      "-c",
      `curl -s --max-time 90 -w "\n%{http_code}" -X POST -H "Content-Type: application/json" --data-binary @- "${SERVE_BASE}/session/${sessionId}/prompt_async"`,
    ],
    body,
  );
  const nl = out.lastIndexOf("\n");
  const respBody = nl !== -1 ? out.slice(0, nl) : "";
  const code = nl !== -1 ? out.slice(nl + 1).trim() : "200";
  if (code !== "200" && code !== "201" && code !== "202" && code !== "204") {
    let parsed: { error?: unknown; message?: string } = {};
    try { parsed = JSON.parse(respBody) as typeof parsed; } catch {}
    const msg = typeof parsed.error === "string" ? parsed.error : (typeof parsed.message === "string" ? parsed.message : respBody.slice(0, 1000) || `HTTP ${code}`);
    throw new Error(`${code} sendSessionMessage failed: ${msg}`);
  }
  if (respBody) {
    try {
      const j = JSON.parse(respBody) as { error?: unknown };
      if (j.error) throw new Error(String(j.error).slice(0, 1000));
    } catch (e) {
      if (e instanceof Error && e.message.includes("429") || String(e).toLowerCase().includes("rate")) throw e;
    }
  }
}

export async function approvePermission(
  containerName: string,
  sessionId: string,
  permissionId: string,
): Promise<void> {
  const body = JSON.stringify({ response: "always" });
  if (HOST_MODE) {
    await fetch(`${SERVE_BASE}/session/${sessionId}/permissions/${permissionId}`, { method:"POST", headers:{ "Content-Type":"application/json"}, body });
    return;
  }
  await execWithStdin(
    containerName,
    [
      "sh",
      "-c",
      `curl -s --max-time 10 -X POST -H "Content-Type: application/json" --data-binary @- "${SERVE_BASE}/session/${sessionId}/permissions/${permissionId}"`,
    ],
    body,
  );
}

export async function rejectQuestion(containerName: string, requestId: string, directory: string): Promise<void> {
  const dir = HOST_MODE ? toHostDir(directory) : directory;
  if (HOST_MODE) {
    await fetch(`${SERVE_BASE}/question/${requestId}/reject?directory=${encodeURIComponent(dir)}`, { method:"POST" });
    return;
  }
  await execCapture(containerName, [
    "sh",
    "-c",
    `curl -sf --max-time 10 -X POST "${SERVE_BASE}/question/${requestId}/reject?directory=${encodeURIComponent(dir)}"`,
  ]);
}

export async function replyQuestion(
  containerName: string,
  requestId: string,
  answers: string[][],
  directory: string,
): Promise<void> {
  const dir = HOST_MODE ? toHostDir(directory) : directory;
  const body = JSON.stringify({ answers });
  if (HOST_MODE) {
    await fetch(`${SERVE_BASE}/question/${requestId}/reply?directory=${encodeURIComponent(dir)}`, { method:"POST", headers:{ "Content-Type":"application/json"}, body });
    return;
  }
  await execWithStdin(
    containerName,
    [
      "sh",
      "-c",
      `curl -sf --max-time 10 -X POST -H "Content-Type: application/json" --data-binary @- "${SERVE_BASE}/question/${requestId}/reply?directory=${encodeURIComponent(dir)}"`,
    ],
    body,
  );
}

export async function abortSession(containerName: string, sessionId: string): Promise<void> {
  if (HOST_MODE) {
    try { await fetch(`${SERVE_BASE}/session/${sessionId}/abort`, { method:"POST", signal: AbortSignal.timeout(10000) }); } catch {}
    return;
  }
  await execCapture(containerName, [
    "sh",
    "-c",
    `curl -s --max-time 10 -X POST "${SERVE_BASE}/session/${sessionId}/abort"`,
  ]);
}

export function streamServeEvents(opts: {
  containerName: string;
  directory: string;
  onEvent: (evt: ServeEvent) => Promise<void> | void;
  onConnected?: () => void;
  signal: AbortSignal;
}): Promise<void> {
  const { containerName, directory, onEvent, onConnected, signal } = opts;
  const dir = HOST_MODE ? toHostDir(directory) : directory;
  const dockerArgs = HOST_MODE ? ["-sN","--max-time","86400", `${SERVE_BASE}/event?directory=${encodeURIComponent(dir)}`] : ["exec","-i",containerName,"sh","-c",`curl -sN --max-time 86400 "${SERVE_BASE}/event?directory=${encodeURIComponent(dir)}"`];
  const cmd = HOST_MODE ? "curl" : "docker";
  const args = HOST_MODE ? dockerArgs : dockerArgs;
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

  let buffer = "";
  let settled = false;
  let connected = false;
  let eventQueue: Promise<void> = Promise.resolve();

  const onAbort = () => {
    if (settled) return;
    settled = true;
    child.kill("SIGKILL");
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const dispatch = (payload: string) => {
    if (!payload) return;
    let evt: ServeEvent;
    try {
      evt = JSON.parse(payload) as ServeEvent;
    } catch {
      return;
    }
    if (!evt || !evt.type) return;
    if (!connected) {
      connected = true;
      onConnected?.();
    }
    eventQueue = eventQueue
      .then(() => onEvent(evt))
      .catch((e) => console.error("[aurex-worker] event handler error:", e));
  };

  const onChunk = (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data:")) dispatch(line.slice(5).trim());
    }
  };

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  let stderrBuf = "";
  child.stderr.on?.("data", (c: Buffer) => { stderrBuf += c.toString(); });
  return new Promise<void>((resolve, reject) => {
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (code !== 0 && code !== null && !signal.aborted) {
        const hint = stderrBuf.slice(-500).trim();
        const msg = hint ? `event stream exited with code ${code}: ${hint}` : `event stream exited with code ${code} (network failure)`;
        eventQueue.finally(() => reject(new Error(msg)));
        return;
      }
      if (stderrBuf.includes("curl:") && !signal.aborted) {
        const msg = `network failure: ${stderrBuf.slice(-500).trim()}`;
        eventQueue.finally(() => reject(new Error(msg)));
        return;
      }
      eventQueue.finally(() => resolve());
    });
  });
}
