import { prisma } from "@aurex/db";
import { workspaceContainerName, ensureWorkspaceDir, writeFileInWorkspace, readFileInWorkspace } from "@aurex/docker";
import {
  projectWorkspacePath,
  workspaceRunDirectory,
  AUTO_MODEL_ID,
  autoSelectModel,
  agentContextBlock,
  type DetectedProject,
} from "@aurex/shared";
import {
  AUREX_AGENT_SYSTEM_PROMPT,
  AUREX_AGENT_FILE,
} from "@aurex/shared/agent-prompt";
import { getPrompt, buildSystemPromptForTask } from "@aurex/shared/prompts";
import { nextRunSeq, publishRunEvent } from "./pubsub.js";
import { ensureWorkspace } from "./workspace.js";
import {
  abortSession,
  approvePermission,
  createSession,
  ensureServeRunning,
  eventSessionID,
  rejectQuestion,
  replyQuestion,
  sendSessionMessage,
  streamServeEvents,
  type ServeEvent,
} from "./opencodeServe.js";
import { homedir } from "node:os";
import { RUN_TIMEOUT_MS, API_URL, INTERNAL_KEY, HOST_MODE } from "./config.js";
import { buildPromptParts, resolveModel } from "./ingest.js";

// How long the watcher must see silence (no agent events) before considering a
// run done. Serve's explicit idle signals are unreliable on long-lived event
// streams, so a quiet period after real activity is the deterministic signal.
export const QUIET_COMPLETE_MS = 45_000;

const ALLOWED_HOST_PREFIXES = (() => {
  const home = process.env.HOME ?? homedir() ?? "/home/aurex";
  // Allow the aurex checkout itself + the user's home + tmp/workspace
  return [
    `${home}/aurex`,
    home,
    "/tmp",
    "/workspace",
  ];
})();
function isAllowedHostPath(p: string): boolean {
  // Normalize: resolve .. and ensure absolute
  const normalized = p.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  if (normalized === "/") return false;
  // Must be under an allowed prefix; also reject traversal of sensitive dirs
  const blocked = ["/etc", "/var/log", "/var/www", "/root", "/boot", "/proc", "/sys"];
  for (const b of blocked) {
    if (normalized === b || normalized.startsWith(b + "/")) return false;
  }
  for (const prefix of ALLOWED_HOST_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix + "/")) return true;
  }
  return false;
}

function extractHostPath(task: string): string | null {
  const m = task.match(/\[HOST PATH:\s*([^\]\n]+)\]/);
  if (!m) return null;
  const p = m[1].trim();
  if (!p.startsWith("/")) return null;
  if (p.includes("..")) return null;
  if (p === "/") return null;
  if (!isAllowedHostPath(p)) {
    console.warn(`[security] rejected HOST PATH outside allowed prefixes: ${p}`);
    return null;
  }
  return p;
}
import { detectImageRequest, processImageGeneration } from "./imageGen.js";

export interface ActiveRun {
  runId: string;
  sessionId: string;
  containerName: string;
  directory: string;
  abort: AbortController;
  timer: NodeJS.Timeout;
}

export interface ActiveRunEntry extends ActiveRun {
  connected: Promise<void>;
  resolveConnected: () => void;
  lastEventAt: number;
  completeIfIdle?: () => Promise<void>;
}/**
 * In-process registry of live agent sessions. The BullMQ job completes after
 * the session is set up; the event stream + status transitions keep running in
 * the background here. The chat handler resets the inactivity timeout or
 * re-attaches a dead stream.
 */
export const activeRuns = new Map<string, ActiveRun>();

function props(evt: ServeEvent): Record<string, unknown> {
  if (evt.properties && typeof evt.properties === "object") return evt.properties;
  if (evt.data && typeof evt.data === "object") return evt.data;
  return {};
}

export function resetRunTimeout(runId: string) {
  const active = activeRuns.get(runId);
  if (!active) return;
  clearTimeout(active.timer);
  active.timer = setTimeout(() => void timeoutRun(runId), RUN_TIMEOUT_MS);
}

function classifyError(message: string): { kind: "token_limit" | "rate_limit" | "network" | "other"; retryable: boolean } {
  const m = message.toLowerCase();
  if (m.includes("token") && (m.includes("limit") || m.includes("exceed") || m.includes("context length") || m.includes("max_tokens") || m.includes("context window"))) return { kind: "token_limit", retryable: false };
  if (m.includes("context length") || m.includes("too many tokens") || m.includes("maximum context")) return { kind: "token_limit", retryable: false };
  if (m.includes("quota") || m.includes("billing") || m.includes("insufficient_quota")) return { kind: "token_limit", retryable: false };
  if (m.includes("429") || m.includes("rate limit") || m.includes("rate_limit") || m.includes("too many requests") || m.includes("overloaded") || m.includes("capacity")) return { kind: "rate_limit", retryable: true };
  if (m.includes("network") || m.includes("econnreset") || m.includes("econnrefused") || m.includes("etimedout") || m.includes("enotfound") || m.includes("socket hang up") || m.includes("fetch failed") || m.includes("curl:") || m.includes("timeout") || m.includes("503") || m.includes("502") || m.includes("504")) return { kind: "network", retryable: true };
  return { kind: "other", retryable: false };
}

async function publishVisibleError(runId: string, message: string, opts?: { retryable?: boolean; kind?: string }) {
  const kind = opts?.kind ?? classifyError(message).kind;
  const retryable = opts?.retryable ?? classifyError(message).retryable;
  const seq = await nextRunSeq(runId);
  const createdAt = new Date().toISOString();
  const data: Record<string, unknown> = { error: message, kind, retryable };
  if (retryable) (data as Record<string, unknown>).hint = "Retrying automatically… you can also click Retry to continue.";
  if (kind === "token_limit") (data as Record<string, unknown>).hint = "Token/context limit reached — try a shorter task, smaller files, or switch model.";
  if (kind === "rate_limit") (data as Record<string, unknown>).hint = "Model rate limit hit — will retry shortly. If it persists, try again in a minute or switch model.";
  try {
    await prisma.agentEvent.create({ data: { runId, seq, type: "error", data: data as object, createdAt: new Date(createdAt) } });
  } catch (e) {
    console.error(`[aurex-worker] failed to persist error event for ${runId}:`, e);
  }
  try { await publishRunEvent({ runId, seq, type: "error", data, createdAt }); } catch (e) { console.error(`[aurex-worker] publishVisibleError failed:`, e); }
}

async function withRetry<T>(label: string, runId: string | null, fn: () => Promise<T>, opts?: { retries?: number; baseMs?: number }): Promise<T> {
  const retries = opts?.retries ?? 4;
  const baseMs = opts?.baseMs ?? 1200;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const { retryable } = classifyError(msg);
      // Only retry on network/rate_limit and transient 5xx; token_limit never retries
      const shouldRetry = retryable && attempt < retries;
      console.warn(`[aurex-worker] ${label} failed (attempt ${attempt+1}/${retries+1}, retryable=${shouldRetry}): ${msg}`);
      // Only surface final failure or non-retryable errors to avoid flooding agentEvent table
      if (runId && (!shouldRetry || attempt === retries)) {
        await publishVisibleError(runId, `${label} failed: ${msg}${shouldRetry ? ` — retrying…` : ""}`, { retryable: shouldRetry }).catch(() => {});
      } else if (runId && shouldRetry) {
        console.log(`[aurex-worker] ${label} will retry (attempt ${attempt+1}) — suppressing intermediate error event`);
      }
      if (!shouldRetry) throw e;
      await new Promise((r) => setTimeout(r, Math.min(baseMs * Math.pow(1.7, attempt), 15000)));
    }
  }
  throw lastErr;
}

async function timeoutRun(runId: string) {
  const active = activeRuns.get(runId);
  if (!active) return;
  activeRuns.delete(runId);
  active.abort.abort();
  try { await abortSession(active.containerName, active.sessionId); } catch (e) { console.warn(`[aurex-worker] abortSession on timeout failed for ${runId}:`, (e as Error).message); }
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (run && run.status === "running") {
    const msg = `run timed out after ${RUN_TIMEOUT_MS}ms`;
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: "timeout", error: msg, exitCode: 1, completedAt: new Date() },
    });
    await publishVisibleError(runId, msg, { kind: "other", retryable: false });
    await publishRunEvent({
      runId,
      seq: await nextRunSeq(runId),
      type: "system",
      createdAt: new Date().toISOString(),
      data: { text: "Agent run timed out" },
      status: "timeout",
    });
  }
}

// --- interactive watcher --------------------------------------------------

interface WatcherState {
  textParts: string[];
  // True once a real assistant answer delta (`text`) has been delivered.
  // Reasoning/thinking deltas are collected in textParts (for image-marker
  // detection and result reconstruction) but must NOT count as delivered text:
  // if they did, a session that went idle mid-thought could be marked
  // completed while the agent was still working.
  deliveredText: boolean;
  partText: Map<string, string>;
  toolEmitted: Set<string>;
  userMessageIDs: Set<string>;
  questionsAsked: Set<string>;
  questionsResolved: Set<string>;
  imageGenerationTriggered: boolean;
  eventCount: number;
}

function createWatcher(active: ActiveRunEntry) {
  const state: WatcherState = {
    textParts: [],
    deliveredText: false,
    partText: new Map(),
    toolEmitted: new Set(),
    userMessageIDs: new Set(),
    questionsAsked: new Set(),
    questionsResolved: new Set(),
    imageGenerationTriggered: false,
    eventCount: 0,
  };
  active.lastEventAt = Date.now();

  // Deterministic completion fallback: the serve's idle signals
  // (`session.idle` / `session.status`) are delivered unreliably to long-lived
  // event streams, and the stream itself can silently drop (entry deleted).
  // Completion therefore records lastEventAt here and a module-level sweep
  // (index.ts) flips the run to completed once it has been quiet for
  // QUIET_COMPLETE_MS — independent of any single stream's lifetime.
  active.completeIfIdle = completeRunIfIdle;

  /**
   * Mark the run completed when the agent session goes idle. Durable: writes
   * the status update AND a persisted "Agent run completed" event directly, so
   * completion survives worker restarts and is never lost to SSE-only delivery.
   * Idempotent: only transitions from "running".
   *
   * This is the single enforcement point for the delivered-text gate: every
   * caller (session.idle, session.status, and the module-level quiet-completion
   * sweep in index.ts) funnels through here. Reasoning-only output must never
   * count as delivered — a run that produced only thinking/planning deltas and
   * then went quiet is still working and must stay "running".
   */
  async function completeRunIfIdle() {
    try {
      if (!state.deliveredText && !state.imageGenerationTriggered) return;
      const run = await prisma.agentRun.findUnique({ where: { id: active.runId } }).catch(() => null);
      if (!run || run.status !== "running") return;
      const result = state.textParts.join("\n").trim() || null;
      await prisma.agentRun.update({
        where: { id: active.runId },
        data: { status: "completed", result, exitCode: 0, completedAt: new Date() },
      });
      const seq = await nextRunSeq(active.runId);
      const createdAt = new Date().toISOString();
      await prisma.agentEvent
        .create({ data: { runId: active.runId, seq, type: "system", data: { text: "Agent run completed" }, createdAt: new Date(createdAt) } })
        .catch((e) => console.error(`[aurex-worker] failed to persist completion event for ${active.runId}:`, e));
      await publishRunEvent({ runId: active.runId, seq, type: "system", data: { text: "Agent run completed" }, createdAt, status: "completed" }).catch(() => {});
      console.log(`[aurex-worker] run ${active.runId} completed (session idle)`);
      void triggerAutoPublish(run.projectId).catch(() => {});
    } catch (e) {
      console.error(`[aurex-worker] completeRunIfIdle failed for ${active.runId}:`, e);
    }
  }

  async function emit(evt: { type: string; data: unknown; status?: string }) {
    let seq = await nextRunSeq(active.runId);
    const createdAt = new Date().toISOString();
    try {
      await prisma.agentEvent.create({
        data: { runId: active.runId, seq, type: evt.type, data: evt.data as object, createdAt: new Date(createdAt) },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Unique constraint on (runId, seq) — retry with fresh seq (concurrent writers)
      if (msg.includes("Unique constraint") || (e as { code?: string }).code === "P2002") {
        seq = await nextRunSeq(active.runId);
        await prisma.agentEvent.create({
          data: { runId: active.runId, seq, type: evt.type, data: evt.data as object, createdAt: new Date(createdAt) },
        });
      } else throw e;
    }
    await publishRunEvent({ runId: active.runId, seq, type: evt.type, data: evt.data, createdAt, status: evt.status });
  }

  async function setRunStatus(status: string, extra: Record<string, unknown> = {}) {
    await prisma.agentRun.update({ where: { id: active.runId }, data: { status, ...extra } });
    await publishRunEvent({
      runId: active.runId,
      seq: await nextRunSeq(active.runId),
      type: "system",
      createdAt: new Date().toISOString(),
      data: { text: `Agent run ${status}` },
      status,
    });
  }

  async function mapPart(part: Record<string, unknown> & { id?: string; type?: string }) {
    const t = part.type;
    const partId = part.id;
    if (t === "text" || t === "reasoning") {
      const text = typeof part.text === "string" ? part.text : "";
      const prev = (partId && state.partText.get(partId)) || "";
      if (text.length > prev.length && partId) {
        const delta = text.slice(prev.length);
        state.partText.set(partId, text);
        state.textParts.push(delta);
        // Only a real assistant answer delta (`text`) counts as delivered.
        // Reasoning deltas are collected in textParts for marker detection and
        // result reconstruction but must NOT set deliveredText — if they did, a
        // session that went idle mid-thought could be marked completed while the
        // agent was still working.
        if (t === "text") state.deliveredText = true;

        // Check for image generation marker in the accumulated text — use part's full text
        // to avoid O(N²) join on every delta; only fallback to join if marker spans deltas
        let imageRequest = detectImageRequest(text);
        if (!imageRequest) {
          const fullText = state.textParts.join("");
          // Only do expensive full join check if marker could be split across deltas
          if (fullText.length < 50000) imageRequest = detectImageRequest(fullText);
        }
        if (imageRequest && !state.imageGenerationTriggered) {
          state.imageGenerationTriggered = true;
          console.log(`[aurex-worker] Image generation detected in run ${active.runId}`);

          // Emit the clean text — strip marker from the delta, not via length math
          const cleanFull = imageRequest.cleanText;
          const priorLen = state.textParts.slice(0, -1).join("").length;
          const cleanDelta = cleanFull.slice(priorLen);
          if (cleanDelta) {
            await emit({ type: t, data: { part: { type: t, text: cleanDelta } } });
          }

          // Trigger image generation in background
          const run = await prisma.agentRun.findUnique({ where: { id: active.runId } });
          if (run) {
            void processImageGeneration(active.runId, run.projectId, imageRequest.request).catch((err) => {
              console.error(`[aurex-worker] Image generation failed:`, err);
            });
          }
        } else {
          await emit({ type: t, data: { part: { type: t, text: delta } } });
        }
      }
    } else if (t === "tool" && partId) {
      // Suppress tool events after image generation is triggered
      if (state.imageGenerationTriggered) return;
      const st = (part.state as { status?: string } | undefined)?.status;
      const completed = st === "completed" || st === "error";
      const emitKey = completed ? `tc:${partId}` : `tr:${partId}`;
      if (!state.toolEmitted.has(emitKey)) {
        if (completed) state.toolEmitted.add(emitKey);
        await emit({
          type: "tool",
          data: {
            part: {
              type: "tool",
              tool: part.tool,
              state: part.state,
              input: (part.state as { input?: unknown } | undefined)?.input,
            },
          },
        });
      }
    } else if (t === "step-start" && partId) {
      // Suppress step events after image generation is triggered
      if (state.imageGenerationTriggered) return;
      const key = `ss:${partId}`;
      if (!state.toolEmitted.has(key)) {
        state.toolEmitted.add(key);
        await emit({ type: "step_start", data: { part: { type: "step-start" } } });
      }
    } else if (t === "step-finish" && partId) {
      // Suppress step events after image generation is triggered
      if (state.imageGenerationTriggered) return;
      const key = `sf:${partId}`;
      if (!state.toolEmitted.has(key)) {
        state.toolEmitted.add(key);
        await emit({ type: "step_finish", data: { part: { type: "step-finish", reason: part.reason } } });
      }
    }
  }

  async function handle(evt: ServeEvent) {
    const sessionID = eventSessionID(evt);
    if (sessionID && sessionID !== active.sessionId) return;
    // Ignore serve-internal chatter (`server.heartbeat`, `server.connected`):
    // it flows continuously even when the agent is idle, and counting it would
    // keep the lastEventAt clock fresh forever — blocking quiet-completion and
    // leaving runs stuck in "running" with the chat input locked.
    if (evt.type.startsWith("server.")) return;
    if (process.env.AUREX_EVT_DEBUG) console.log(`[aurex-worker][evt] ${evt.type} sid=${sessionID ?? "none"} run=${active.runId}`);
    state.eventCount += 1;
    active.lastEventAt = Date.now();

    switch (evt.type) {
      case "message.updated": {
        const info = props(evt).info as { id?: string; role?: string } | undefined;
        if (info && info.role === "user" && info.id) state.userMessageIDs.add(info.id);
        break;
      }
      case "message.part.updated": {
        const part = props(evt).part as Record<string, unknown> & { id?: string; messageID?: string; type?: string };
        if (!part?.type) break;
        if (part.messageID && state.userMessageIDs.has(part.messageID)) break;
        await mapPart(part);
        break;
      }
      case "session.idle": {
        // Only complete when a real assistant answer has been delivered (or image
        // generation is in flight). A session idle that only ever produced
        // reasoning/thinking deltas must NOT complete the run — the agent may
        // still be working.
        if (state.deliveredText || state.imageGenerationTriggered) {
          await completeRunIfIdle();
        }
        break;
      }
      case "session.status": {
        const st = (props(evt).status as { type?: string } | undefined)?.type;
        // The serve reports idle both via `session.idle` and `session.status`.
        // Only complete when a real assistant answer has been delivered (or image
        // generation is in flight), so a pre-prompt idle at session start can't
        // complete an empty run — and a mid-thought idle can't complete a run
        // whose agent is still working.
        if (st === "idle" && (state.deliveredText || state.imageGenerationTriggered)) {
          await completeRunIfIdle();
        }
        break;
      }
      case "session.error": {
        const raw = props(evt).error as { message?: string; code?: string; status?: number; details?: unknown } | undefined;
        const message = raw?.message ?? (typeof raw?.details === "string" ? raw.details : null) ?? "agent session error";
        const { kind, retryable } = classifyError(message);
        // Always surface the exact provider message — never swallow
        await publishVisibleError(active.runId, message, { kind, retryable });
        // Also keep legacy emit for UI compatibility
        await emit({ type: "error", data: { error: message, kind, retryable } });
        const run = await prisma.agentRun.findUnique({ where: { id: active.runId } });
        if (run && run.status === "running") {
          // For retryable network/rate-limit, keep running and let retry logic reconnect instead of marking failed immediately
          if (retryable && (kind === "network" || kind === "rate_limit")) {
            console.warn(`[aurex-worker] session.error retryable (${kind}) for ${active.runId}: ${message} — will retry`);
            // Do NOT mark failed yet; trigger reconnection via watcher retry
            break;
          }
          await prisma.agentRun.update({
            where: { id: active.runId },
            data: { status: "failed", error: `[${kind}] ${message}`, exitCode: 1, completedAt: new Date() },
          });
          await publishRunEvent({
            runId: active.runId,
            seq: await nextRunSeq(active.runId),
            type: "system",
            createdAt: new Date().toISOString(),
            data: { text: `Agent failed: ${message}` },
            status: "failed",
          });
        }
        break;
      }
      case "permission.v2.asked":
      case "permission.asked": {
        const permissionId = props(evt).id as string | undefined;
        if (permissionId) {
          try { await approvePermission(active.containerName, active.sessionId, permissionId); }
          catch (e) { console.warn(`[aurex-worker] approvePermission failed for ${active.runId}:`, (e as Error).message); await publishVisibleError(active.runId, `approvePermission failed: ${(e as Error).message}`); }
        }
        break;
      }
      case "question.v2.asked":
      case "question.asked": {
        const requestId = (props(evt).id as string) ?? (props(evt).requestID as string | undefined);
        if (!requestId || state.questionsAsked.has(requestId)) break;
        const questions = (props(evt).questions as Array<Record<string, unknown>> | undefined)
          ?.map((q) => ({
            question: q.question,
            header: q.header,
            options: q.options,
            multiple: q.multiple,
            custom: q.custom,
          }))
          .filter((q) => typeof q.question === "string" && typeof q.header === "string");
        if (!questions || questions.length === 0) {
          try { await rejectQuestion(active.containerName, requestId, active.directory); }
          catch (e) { console.warn(`[aurex-worker] rejectQuestion failed for ${active.runId}:`, (e as Error).message); await publishVisibleError(active.runId, `rejectQuestion failed: ${(e as Error).message}`); }
          break;
        }
        state.questionsAsked.add(requestId);
        await emit({
          type: "question",
          data: { requestId, questions, sessionId: active.sessionId },
        });
        break;
      }
      case "question.v2.replied":
      case "question.replied": {
        const requestId = (props(evt).requestID as string) ?? (props(evt).id as string | undefined);
        if (!requestId || state.questionsResolved.has(requestId)) break;
        state.questionsResolved.add(requestId);
        await emit({
          type: "question_reply",
          data: { requestId, answers: props(evt).answers },
        });
        break;
      }
      case "question.v2.rejected":
      case "question.rejected": {
        const requestId = (props(evt).requestID as string) ?? (props(evt).id as string | undefined);
        if (!requestId || state.questionsResolved.has(requestId)) break;
        state.questionsResolved.add(requestId);
        await emit({
          type: "question_reply",
          data: { requestId, rejected: true },
        });
        break;
      }
      default:
        break;
    }
  }

  return handle;
}

/**
 * Start (or resume) the background event stream for a run. Resolves once the
 * SSE connection delivers its first event (bounded ~10s so setup never hangs).
 */
export function startWatcher(
  runId: string,
  sessionId: string,
  containerName: string,
  directory: string,
): Promise<void> {
  const existing = activeRuns.get(runId) as ActiveRunEntry | undefined;
  if (existing) return existing.connected;

  const abort = new AbortController();
  const timer = setTimeout(() => void timeoutRun(runId), RUN_TIMEOUT_MS);
  let resolved = false;
  let entry!: ActiveRunEntry;
  let connectTimer: NodeJS.Timeout;
  let resolveConnected: (() => void) | undefined;
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });
  const finish = () => {
    if (resolved) return;
    resolved = true;
    clearTimeout(connectTimer);
    resolveConnected?.();
  };
  entry = { runId, sessionId, containerName, directory, abort, timer, connected, resolveConnected: finish, lastEventAt: Date.now() };
  connectTimer = setTimeout(finish, 10000);
  activeRuns.set(runId, entry);

  const handle = createWatcher(entry);
  void (async () => {
    const MAX_RETRIES = 12;
    let attempt = 0;
    while (true) {
      if (abort.signal.aborted) break;
      const runCheck = await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true } }).catch(() => null);
      if (runCheck && ["completed","failed","cancelled","timeout"].includes(runCheck.status)) break;
      try {
        await streamServeEvents({
          containerName,
          directory,
          signal: abort.signal,
          onConnected: finish,
          onEvent: handle,
        });
        // clean exit (session idle / completed) — no retry needed
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const { retryable } = classifyError(msg);
        attempt++;
        console.error(`[aurex-worker] event stream for run ${runId} failed (attempt ${attempt}/${MAX_RETRIES}, retryable=${retryable}):`, msg);
        if (!retryable && !msg.toLowerCase().includes("aborted") && !msg.includes("signal")) {
          // Non-retryable or unknown — surface and break
          await publishVisibleError(runId, `Stream failed: ${msg}`, { retryable: false }).catch(() => {});
        }
        if (abort.signal.aborted) { finish(); break; }
        if (attempt >= MAX_RETRIES) {
          await publishVisibleError(runId, `Stream failed after ${attempt} retries: ${msg}. Click Retry to continue.`, { retryable: true }).catch(() => {});
          // Mark failed so UI shows Retry button, but keep session for manual retry
          const cur = await prisma.agentRun.findUnique({ where: { id: runId } }).catch(() => null);
          if (cur && cur.status === "running") {
            await prisma.agentRun.update({ where: { id: runId }, data: { status: "failed", error: `network failure: ${msg}`, completedAt: new Date() } }).catch(() => {});
            await publishRunEvent({ runId, seq: await nextRunSeq(runId), type: "system", createdAt: new Date().toISOString(), data: { text: `Run failed — network error, you can retry` }, status: "failed" }).catch(() => {});
          }
          finish();
          break;
        }
        // Retryable: surface transient warning, wait with exponential backoff
        await publishVisibleError(runId, `Network glitch: ${msg} — retrying in ${Math.min(2*attempt, 30)}s (attempt ${attempt}/${MAX_RETRIES})`, { retryable: true }).catch(() => {});
        // Ensure serve still healthy before retry
        try { await ensureServeRunning(containerName); } catch (ee) { console.warn(`[aurex-worker] ensureServeRunning before retry failed:`, (ee as Error).message); }
        const delay = Math.min(1000 * Math.pow(1.8, attempt), 30000);
        await new Promise((r) => setTimeout(r, delay));
        if (abort.signal.aborted) break;
        continue;
      }
    }
    finish();
    if (activeRuns.get(runId) === entry) {
      activeRuns.delete(runId);
      clearTimeout(entry.timer);
    }
  })();

  return entry.connected;
}

/** Directory an agent works in: project folder inside the user's personal
 * workspace, or the legacy per-project workspace path. */
function runDirectory(
  workspace: { path: string | null; projectId: string | null } | null,
  projectName: string,
): string {
  if (!workspace) return projectWorkspacePath(projectName);
  const personal = workspace.projectId == null;
  return workspaceRunDirectory(workspace.path, personal, projectName);
}

async function ensureRunDirectory(
  containerName: string,
  directory: string,
  systemPrompt?: string,
): Promise<void> {
  await ensureWorkspaceDir(containerName, directory);
  // Append worker's modular prompts to existing AGENTS.md (don't replace).
  // The project's AGENTS.md provides base identity; worker adds task-specific capabilities.
  if (systemPrompt) {
    const agentFile = `${directory}/${AUREX_AGENT_FILE}`;
    try {
      const existing = (await readFileInWorkspace(containerName, agentFile)).content ?? "";
      const separator = existing ? "\n\n---\n\n# WORKER CAPABILITIES (appended)\n\n" : "";
      await writeFileInWorkspace(containerName, agentFile, existing + separator + systemPrompt);
    } catch {
      // Fallback: write anyway if read fails
      await writeFileInWorkspace(containerName, agentFile, systemPrompt);
    }
  }
}

// --- run setup ---

export async function processAgentRun(runId: string, promptId?: string) {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { project: true, attachments: { orderBy: { createdAt: "asc" } } },
  });
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status === "cancelled") return;

  await prisma.agentRun.update({
    where: { id: runId },
    data: { status: "running", startedAt: new Date() },
  });
  await publishRunEvent({
    runId,
    seq: 0,
    type: "system",
    createdAt: new Date().toISOString(),
    data: { text: "Agent run started" },
    status: "running",
  });

  const workspaceId = run.workspaceId;
  if (!workspaceId) throw new Error(`run ${runId} has no workspace`);

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  const baseDir = runDirectory(workspace, run.project?.name ?? "project");
  const hostPath = extractHostPath(run.task);
  const directory = HOST_MODE && hostPath ? hostPath : baseDir;
  if (HOST_MODE && hostPath) console.log(`[run ${runId}] HOST MODE — using host directory ${directory} (from task hostPath)`);

  let containerName: string;
  try {
    containerName = await withRetry("ensureWorkspace", runId, () => ensureWorkspace(workspaceId).then((n) => n || workspaceContainerName(workspaceId)));
    await withRetry("ensureServeRunning", runId, () => ensureServeRunning(containerName));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await publishVisibleError(runId, `Failed to start workspace/agent: ${msg}`);
    await prisma.agentRun.update({ where: { id: runId }, data: { status: "failed", error: msg, completedAt: new Date() } }).catch(() => {});
    await publishRunEvent({ runId, seq: await nextRunSeq(runId), type: "system", createdAt: new Date().toISOString(), data: { text: `Failed to start: ${msg}` }, status: "failed" }).catch(() => {});
    throw e;
  }

  // Build the system prompt from the prompt system
  let systemPrompt: string;
  let promptSource: string;
  if (run.promptId) {
    const customPrompt = getPrompt(run.promptId);
    systemPrompt = customPrompt ?? AUREX_AGENT_SYSTEM_PROMPT;
    promptSource = customPrompt ? `custom:${run.promptId}` : "legacy-fallback";
  } else {
    const { systemPrompt: builtPrompt, promptIds } = buildSystemPromptForTask(run.task);
    systemPrompt = builtPrompt;
    promptSource = promptIds.length > 0 ? `modular:${promptIds.join(",")}` : "builtin-fallback";
  }
  console.log(`[run ${runId}] system prompt source: ${promptSource}`);
  // Host mode: force host-aware prompt — override any isolated-workspace wording
  if (HOST_MODE) {
    systemPrompt += `\n\n---\n\n# HOST MODE ACTIVE\nYou are running DIRECTLY ON THE HOST SERVER (not isolated). WORKDIR is \`${directory}\` on the host. Full filesystem is accessible: /home, /var/log, /etc/nginx, /var/www, /tmp, /opt, and /. Use host tools (systemctl, journalctl, pm2, docker, apt, nginx -t) and ServerPanel APIs at /api/* . Do NOT claim you are in an isolated workspace or Docker container.`;
    console.log(`[run ${runId}] HOST MODE prompt injected for ${directory}`);
  }

  // If this project was created by a codebase import, append the detected
  // technology context so the agent treats it as an existing codebase.
  try {
    const imp = await prisma.projectImport.findFirst({
      where: { projectId: run.projectId, status: "ready" },
      orderBy: { createdAt: "desc" },
    });
    const detected = imp?.detected as DetectedProject | null | undefined;
    if (imp && detected) {
      systemPrompt += "\n\n" + agentContextBlock(run.project?.name ?? "project", detected, directory);
      console.log(`[run ${runId}] injected import context (import ${imp.id})`);
    }
  } catch (err) {
    console.warn(`[run ${runId}] import-context lookup failed:`, err);
  }

  try {
    await withRetry("ensureRunDirectory", runId, () => ensureRunDirectory(containerName, directory, systemPrompt));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await publishVisibleError(runId, `Failed to prepare workspace directory: ${msg}`);
    throw e;
  }

  let sessionId = run.sessionId;
  const resuming = sessionId != null;
  if (!sessionId) {
    try {
      const session = await withRetry("createSession", runId, () => createSession(containerName, directory));
      sessionId = session.id;
      await prisma.agentRun.update({ where: { id: runId }, data: { sessionId } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await publishVisibleError(runId, `Failed to create agent session: ${msg}`);
      await prisma.agentRun.update({ where: { id: runId }, data: { status: "failed", error: msg, completedAt: new Date() } }).catch(() => {});
      throw e;
    }
  }

  try {
    await startWatcher(runId, sessionId, containerName, directory);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await publishVisibleError(runId, `Failed to start watcher: ${msg}`);
    throw e;
  }

  // The user may have aborted while the session was still being set up — if so,
  // tear it down now instead of letting the agent keep working unwatched.
  const current = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (current && current.status === "cancelled") {
    try { await processAbortRun(runId); } catch (e) { console.warn(`[aurex-worker] processAbortRun failed for ${runId}:`, (e as Error).message); await publishVisibleError(runId, `abort failed: ${(e as Error).message}`).catch(() => {}); }
    return;
  }

  if (!resuming) {
    try {
      const effectiveModel = resolveModel(run.model, run.task, run.attachments);
      const parts = await withRetry("buildPromptParts", runId, () => buildPromptParts({
        containerName,
        task: run.task,
        attachments: run.attachments,
        model: effectiveModel,
      }));
      await withRetry("sendSessionMessage", runId, () => sendSessionMessage(containerName, sessionId!, parts, effectiveModel), { retries: 5 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const { kind } = classifyError(msg);
      await publishVisibleError(runId, `Failed to send prompt to agent: ${msg}`, { kind } as never);
      // For token_limit, mark failed immediately with visible error; for network/rate_limit keep running for retry
      if (kind === "token_limit") {
        await prisma.agentRun.update({ where: { id: runId }, data: { status: "failed", error: msg, completedAt: new Date() } }).catch(() => {});
        await publishRunEvent({ runId, seq: await nextRunSeq(runId), type: "system", createdAt: new Date().toISOString(), data: { text: `Failed: ${msg}` }, status: "failed" }).catch(() => {});
      }
      throw e;
    }
  }
}

/**
 * Forward a user chat message (optionally with attachments) to the run's live
 * opencode session. Attachments are referenced from the container path where
 * the API stored them; the model gets native file parts when it supports the
 * modality, otherwise an OCR / pdftotext extraction.
 */
export async function processChatMessage(runId: string, text: string, attachmentIds: string[] = []) {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { workspace: true, project: true },
  });
  if (!run || !run.sessionId) throw new Error(`run ${runId} has no active agent session`);
  if (!run.workspaceId || !run.workspace) throw new Error(`run ${runId} has no workspace`);

  let containerName: string;
  try {
    containerName = (await withRetry("ensureWorkspace", runId, () => ensureWorkspace(run.workspaceId!).then((n) => n || workspaceContainerName(run.workspaceId!)))) as string;
    await withRetry("ensureServeRunning", runId, () => ensureServeRunning(containerName));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await publishVisibleError(runId, `Chat failed to reach workspace: ${msg}`);
    throw e;
  }

  const baseDirChat = runDirectory(run.workspace, run.project?.name ?? "project");
  const hpChat = extractHostPath(run.task);
  const directory = HOST_MODE && hpChat ? hpChat : baseDirChat;
  try { await withRetry("ensureRunDirectory", runId, () => ensureRunDirectory(containerName, directory)); } catch (e) { const msg = (e as Error).message; await publishVisibleError(runId, `ensureRunDirectory failed: ${msg}`); throw e; }

  const attachments = await prisma.agentAttachment.findMany({
    where: { id: { in: attachmentIds }, projectId: run.projectId },
    orderBy: { createdAt: "asc" },
  });

  const effectiveModel = resolveModel(run.model, text, attachments);
  let parts;
  try { parts = await withRetry("buildPromptParts", runId, () => buildPromptParts({ containerName, task: text, attachments, model: effectiveModel })); }
  catch (e) { const msg = (e as Error).message; await publishVisibleError(runId, `Failed to prepare chat prompt: ${msg}`); throw e; }

  try { await withRetry("sendSessionMessage", runId, () => sendSessionMessage(containerName, run.sessionId!, parts!, effectiveModel), { retries: 5 }); }
  catch (e) { const msg = (e as Error).message; await publishVisibleError(runId, `Failed to send chat message: ${msg}`); throw e; }

  if (["completed", "failed", "cancelled", "timeout"].includes(run.status)) {
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: "running", completedAt: null },
    });
    await publishRunEvent({
      runId,
      seq: await nextRunSeq(runId),
      type: "system",
      createdAt: new Date().toISOString(),
      data: { text: "Continuing from your message" },
      status: "running",
    });
  }

  const active = activeRuns.get(runId);
  if (active) {
    resetRunTimeout(runId);
  } else {
    await startWatcher(runId, run.sessionId, containerName, directory);
  }
}

/** Answer a question the agent asked inside the workspace session. */
export async function processQuestionAnswer(runId: string, requestId: string, answers: string[][]) {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { workspace: true, project: true },
  });
  if (!run || !run.sessionId) throw new Error(`run ${runId} has no active agent session`);
  if (!run.workspaceId || !run.workspace) throw new Error(`run ${runId} has no workspace`);

  let containerName: string;
  try {
    containerName = (await withRetry("ensureWorkspace", runId, () => ensureWorkspace(run.workspaceId!).then((n) => n || workspaceContainerName(run.workspaceId!)))) as string;
    await withRetry("ensureServeRunning", runId, () => ensureServeRunning(containerName));
  } catch (e) { const msg = (e as Error).message; await publishVisibleError(runId, `Question reply failed to reach workspace: ${msg}`); throw e; }

  const directory = runDirectory(run.workspace, run.project?.name ?? "project");
  try { await withRetry("ensureRunDirectory", runId, () => ensureRunDirectory(containerName, directory)); } catch (e) { const msg = (e as Error).message; await publishVisibleError(runId, `ensureRunDirectory failed: ${msg}`); throw e; }

  try { await withRetry("replyQuestion", runId, () => replyQuestion(containerName, requestId, answers, directory)); }
  catch (e) { const msg = (e as Error).message; await publishVisibleError(runId, `Failed to send answer: ${msg}`); throw e; }

  const active = activeRuns.get(runId);
  if (active) {
    resetRunTimeout(runId);
  }
}

/**
 * Re-attach event watchers for runs that are marked running with a session but
 * have no live in-process watcher (e.g. after a worker crash/restart). This
 * keeps `session.idle` / `session.status` completion working for orphaned runs
 * even when no new chat message arrives to re-attach the stream.
 */
export async function healOrphanWatchers(): Promise<void> {
  const orphans = await prisma.agentRun
    .findMany({
      where: { status: "running", sessionId: { not: null }, workspaceId: { not: null } },
      select: { id: true },
      take: 20,
    })
    .catch(() => []);
  for (const r of orphans) {
    if (activeRuns.has(r.id)) continue;
    try {
      const run = await prisma.agentRun.findUnique({
        where: { id: r.id },
        include: { workspace: true, project: true },
      });
      if (!run || !run.sessionId || !run.workspaceId || !run.workspace) continue;
      const containerName = await withRetry("ensureWorkspace", r.id, () =>
        ensureWorkspace(run.workspaceId!).then((n) => n || workspaceContainerName(run.workspaceId!)),
      );
      const hostPath = extractHostPath(run.task);
      const directory = HOST_MODE && hostPath ? hostPath : runDirectory(run.workspace, run.project?.name ?? "project");
      await withRetry("ensureServeRunning", r.id, () => ensureServeRunning(containerName));
      await startWatcher(r.id, run.sessionId, containerName, directory);
      console.log(`[aurex-worker] re-attached watcher for orphaned run ${r.id}`);
    } catch (e) {
      console.warn(`[aurex-worker] heal watcher failed for ${r.id}:`, e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * Abort a run: stop the live agent session and mark the run cancelled.
 * - If the run is still queued, the run job's early return for "cancelled"
 *   status means nothing is ever started.
 * - If the session is live, we tear down the event watcher + session, then
 *   mark it cancelled here (the watcher's session.idle handler would otherwise
 *   mark it completed once the stream drops).
 */
export async function processAbortRun(runId: string) {
  const active = activeRuns.get(runId);
  if (active) {
    clearTimeout(active.timer);
    active.abort.abort();
    activeRuns.delete(runId);
    try { await abortSession(active.containerName, active.sessionId); } catch (e) { console.warn(`[aurex-worker] abortSession for ${runId} failed:`, (e as Error).message); }
  }

  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run) return;
  if (["completed", "failed", "timeout", "cancelled"].includes(run.status)) return;

  await prisma.agentRun.update({
    where: { id: runId },
    data: { status: "cancelled", exitCode: 1, error: "cancelled by user", completedAt: new Date() },
  });
  await publishRunEvent({
    runId,
    seq: await nextRunSeq(runId),
    type: "system",
    createdAt: new Date().toISOString(),
    data: { text: "Agent run cancelled" },
    status: "cancelled",
  });
}

export async function retryRun(runId: string): Promise<void> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, include: { workspace: true, project: true } });
  if (!run) throw new Error(`run ${runId} not found`);
  if (!run.sessionId) throw new Error(`run ${runId} has no session to retry — start a new run`);
  if (!run.workspaceId || !run.workspace) throw new Error(`run ${runId} has no workspace`);
  // Reset to running so watcher/retry loop can continue
  await prisma.agentRun.update({ where: { id: runId }, data: { status: "running", error: null, exitCode: null, completedAt: null } });
  await publishRunEvent({ runId, seq: await nextRunSeq(runId), type: "system", createdAt: new Date().toISOString(), data: { text: "Retrying run — reconnecting…" }, status: "running" });
  await publishVisibleError(runId, "User requested retry — reconnecting agent…", { retryable: true }).catch(() => {});
  let containerName: string;
  try {
    containerName = await withRetry("ensureWorkspace", runId, () => ensureWorkspace(run.workspaceId!).then((n) => n || workspaceContainerName(run.workspaceId!))) as string;
    await withRetry("ensureServeRunning", runId, () => ensureServeRunning(containerName));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await publishVisibleError(runId, `Retry failed to reach workspace: ${msg}`);
    await prisma.agentRun.update({ where: { id: runId }, data: { status: "failed", error: msg, completedAt: new Date() } }).catch(() => {});
    throw e;
  }
  const directory = runDirectory(run.workspace, run.project?.name ?? "project");
  try { await withRetry("ensureRunDirectory", runId, () => ensureRunDirectory(containerName, directory)); } catch (e) { const msg = (e as Error).message; await publishVisibleError(runId, `ensureRunDirectory on retry failed: ${msg}`); throw e; }
  // Reattach watcher (will retry stream with backoff)
  await startWatcher(runId, run.sessionId, containerName, directory);
  // Nudge the session to continue — if it was idle due to network, a no-op prompt can wake it; otherwise just reattached stream will receive next events
  // We send a lightweight continuation if the last status was failed due to network
  try {
    await withRetry("retry-continuation", runId, async () => {
      const parts: import("./ingest.js").PromptPart[] = [{ type: "text" as const, text: "Continue where you left off. If you were interrupted by a network error, resume your previous task." }];
      await sendSessionMessage(containerName, run.sessionId!, parts, run.model);
    }, { retries: 2 });
  } catch (e) {
    console.warn(`[aurex-worker] retry continuation send failed for ${runId}:`, (e as Error).message);
    // Not fatal — watcher is reattached, agent may still be working
  }
}

/**
 * Fire-and-forget: if the project is already published (has a subdomain + URL),
 * automatically republish the latest build to the same URL.
 */
async function triggerAutoPublish(projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { publishedUrl: true, subdomain: true } });
  if (!project?.publishedUrl || !project.subdomain) return;

  try {
    const res = await fetch(`${API_URL}/api/projects/${projectId}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aurex-Internal": INTERNAL_KEY },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      console.log(`[aurex-worker] auto-published project ${projectId} → ${project.publishedUrl}`);
    } else {
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (body.error === "no_changes") {
        console.log(`[aurex-worker] auto-publish skipped for ${projectId}: no changes`);
      } else {
        console.error(`[aurex-worker] auto-publish failed for ${projectId}: ${res.status} ${body.error ?? ""}`);
      }
    }
  } catch (e) {
    console.error(`[aurex-worker] auto-publish error for ${projectId}:`, e);
  }
}
