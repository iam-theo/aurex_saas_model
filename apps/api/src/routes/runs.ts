import { Router, type Request, type Response } from "express";
import { prisma } from "@aurex/db";
import { enqueueRun, enqueueRetry, enqueueChat, enqueueQuestionAnswer, enqueueAbort } from "../queue.js";
import { subscribeRun, unsubscribeRun, publishRunEvent, nextRunSeq, initRunSeq } from "../sse.js";
import { assertProjectAccess, assertRunAccess } from "../access.js";
import { DEFAULT_MODEL } from "../config.js";
import { AUTH_ENABLED, ensurePersonalWorkspace } from "../auth.js";

const router = Router();

/**
 * Validate that requested attachments belong to the given project and return
 * them as Prisma `connect` entries. Unknown/foreign ids are silently dropped
 * (they cannot belong to a run the user owns).
 */
async function resolveAttachmentIds(
  projectId: string,
  attachmentIds: unknown,
): Promise<Array<{ id: string }>> {
  if (!Array.isArray(attachmentIds)) return [];
  const ids = attachmentIds.filter((x): x is string => typeof x === "string");
  if (ids.length === 0) return [];
  const rows = await prisma.agentAttachment.findMany({
    where: { id: { in: ids }, projectId },
    select: { id: true },
  });
  return rows.map((r) => ({ id: r.id }));
}

async function resolveAttachmentRows(
  projectId: string,
  attachmentIds: unknown,
): Promise<
  Array<{ id: string; name: string; storedPath: string; mime: string; size: number }>
> {
  if (!Array.isArray(attachmentIds)) return [];
  const ids = attachmentIds.filter((x): x is string => typeof x === "string");
  if (ids.length === 0) return [];
  return prisma.agentAttachment.findMany({
    where: { id: { in: ids }, projectId },
    select: { id: true, name: true, storedPath: true, mime: true, size: true },
  });
}

router.post("/", async (req, res, next) => {
  try {
    const { projectId, task, model, attachmentIds, promptId } = req.body ?? {};
    if (!projectId || !task) {
      res.status(400).json({ error: "projectId and task are required" });
      return;
    }
    if (typeof task !== "string" || task.trim().length < 3) {
      res.status(400).json({ error: "task must be at least 3 characters" });
      return;
    }
    if (task.length > 20000) {
      res.status(413).json({ error: "task too large (max 20000 chars)" });
      return;
    }
    if (promptId && typeof promptId !== "string") {
      res.status(400).json({ error: "invalid promptId" });
      return;
    }
    // Per-user run concurrency cap
    if (req.user?.id) {
      const running = await prisma.agentRun.count({ where: { project: { ownerId: req.user.id }, status: { in: ["queued", "running"] } } });
      if (running >= 5) {
        res.status(429).json({ error: "too many concurrent runs (max 5) — wait for one to finish" });
        return;
      }
    }
    if (!(await assertProjectAccess(req, res, projectId))) return;
    // Runs execute inside the user's personal workspace (or the project's own
    // legacy workspace for pre-personal-workspace projects).
    let workspace = await prisma.workspace.findUnique({ where: { projectId } });
    if (!workspace) {
      if (!req.user?.id && AUTH_ENABLED) {
        res.status(401).json({ error: "authentication required" });
        return;
      }
      workspace = await ensurePersonalWorkspace(req.user?.id ?? "");
      if (!workspace || (workspace.ownerId ?? "") === "") {
        res.status(500).json({ error: "workspace not available — authentication required" });
        return;
      }
    }
    const provider = (model ?? DEFAULT_MODEL).split("/")[0] ?? "opencode";
    const run = await prisma.agentRun.create({
      data: {
        projectId,
        workspaceId: workspace.id,
        provider,
        model: model ?? DEFAULT_MODEL,
        task,
        promptId,
        status: "queued",
        attachments: {
          connect: await resolveAttachmentIds(projectId, attachmentIds),
        },
      },
    });
    await enqueueRun(run.id, promptId ?? undefined);
    res.status(201).json(run);
  } catch (e) {
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!(await assertRunAccess(req, res, req.params.id))) return;
    const run = await prisma.agentRun.findUnique({
      where: { id: req.params.id },
      include: { events: { orderBy: { seq: "asc" } } },
    });
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    res.json(run);
  } catch (e) {
    next(e);
  }
});

// Abort a running (or queued) run: stops the agent session and marks it cancelled.
router.post("/:id/abort", async (req, res, next) => {
  try {
    const runId = req.params.id;
    if (!(await assertRunAccess(req, res, runId))) return;
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    if (["completed", "failed", "cancelled", "timeout"].includes(run.status)) {
      res.status(409).json({ error: `run is already ${run.status}` });
      return;
    }
    await enqueueAbort(runId);
    res.status(202).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Retry / continue a failed / interrupted run — reconnects stream and resumes session
router.post("/:id/retry", async (req, res, next) => {
  try {
    const runId = req.params.id;
    if (!(await assertRunAccess(req, res, runId))) return;
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) { res.status(404).json({ error: "run not found" }); return; }
    if (["queued", "running"].includes(run.status)) {
      res.status(409).json({ error: `run is already ${run.status} — no retry needed` });
      return;
    }
    if (run.status === "completed") {
      res.status(409).json({ error: "run already completed — start a new run to continue" });
      return;
    }
    if (!run.sessionId) {
      res.status(409).json({ error: "run has no session to retry — start a new run" });
      return;
    }
    // Reset to running immediately so UI polls shows retrying; worker does the heavy work
    await prisma.agentRun.update({ where: { id: runId }, data: { status: "running", error: null, exitCode: null, completedAt: null } });
    const seq = await nextRunSeq(runId);
    const createdAt = new Date().toISOString();
    const data = { text: "Retrying run — reconnecting agent…" };
    await prisma.agentEvent.create({ data: { runId, seq, type: "system", data: data as object, createdAt: new Date(createdAt) } }).catch(() => {});
    await publishRunEvent({ runId, seq, type: "system", data, createdAt, status: "running" }).catch(() => {});
    await enqueueRetry(runId);
    res.status(202).json({ ok: true, status: "running" });
  } catch (e) {
    next(e);
  }
});

// Send a chat message to the run's live agent session.
router.post("/:id/messages", async (req, res, next) => {
  try {
    const runId = req.params.id;
    const { text, attachmentIds } = req.body ?? {};
    if (typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (!(await assertRunAccess(req, res, runId))) return;
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    if (!run.sessionId) {
      res.status(409).json({ error: "run has not started an agent session yet" });
      return;
    }

    // Link attachments to this run (must belong to the same project).
    const attachRows = await resolveAttachmentRows(run.projectId, attachmentIds);
    if (attachRows.length > 0) {
      await prisma.agentAttachment.updateMany({
        where: { id: { in: attachRows.map((a) => a.id) }, runId: null },
        data: { runId },
      });
    }

    const maxSeq = await prisma.agentEvent
      .aggregate({ where: { runId }, _max: { seq: true } })
      .then((r) => r._max.seq ?? 0);
    await initRunSeq(runId, maxSeq);

    const seq = await nextRunSeq(runId);
    const createdAt = new Date().toISOString();
    const data = {
      role: "user",
      text: text.trim(),
      attachments: attachRows.map((a) => ({
        id: a.id,
        name: a.name,
        mime: a.mime,
        storedPath: a.storedPath,
        size: a.size,
      })),
    };
    await prisma.agentEvent.create({
      data: { runId, seq, type: "message", data, createdAt: new Date(createdAt) },
    });
    await publishRunEvent({ runId, seq, type: "message", data, createdAt });

    await enqueueChat(runId, text.trim(), attachRows.map((a) => a.id));
    res.status(202).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Answer a question the agent asked inside the run's workspace session.
router.post("/:id/questions", async (req, res, next) => {
  try {
    const runId = req.params.id;
    const { requestId, answers } = req.body ?? {};
    if (typeof requestId !== "string" || !requestId.trim()) {
      res.status(400).json({ error: "requestId is required" });
      return;
    }
    if (
      !Array.isArray(answers) ||
      answers.some(
        (a) => !Array.isArray(a) || a.some((v) => typeof v !== "string"),
      )
    ) {
      res.status(400).json({ error: "answers must be an array of string arrays" });
      return;
    }
    if (!(await assertRunAccess(req, res, runId))) return;
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    if (!run.sessionId) {
      res.status(409).json({ error: "run has not started an agent session yet" });
      return;
    }

    const maxSeq = await prisma.agentEvent
      .aggregate({ where: { runId }, _max: { seq: true } })
      .then((r) => r._max.seq ?? 0);
    await initRunSeq(runId, maxSeq);

    const seq = await nextRunSeq(runId);
    const createdAt = new Date().toISOString();
    const data = { requestId: requestId.trim(), answers };
    await prisma.agentEvent.create({
      data: { runId, seq, type: "question_reply", data, createdAt: new Date(createdAt) },
    });
    await publishRunEvent({ runId, seq, type: "question_reply", data, createdAt });

    await enqueueQuestionAnswer(runId, requestId.trim(), answers);
    res.status(202).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Attachments linked to a run (uploaded images/PDFs/text docs).
router.get("/:id/attachments", async (req, res, next) => {
  try {
    if (!(await assertRunAccess(req, res, req.params.id))) return;
    const rows = await prisma.agentAttachment.findMany({
      where: { runId: req.params.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, storedPath: true, mime: true, size: true, createdAt: true },
    });
    res.json({ attachments: rows });
  } catch (e) {
    next(e);
  }
});

// SSE stream of agent activity for a run.
router.get("/:id/events", async (req: Request, res: Response, next) => {
  try {
    const runId = req.params.id;
    if (!(await assertRunAccess(req, res, runId))) return;
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Subscribe BEFORE replay to avoid gap where events are missed between
    // the DB query and the subscription.
    const emitter = subscribeRun(runId);
    const pending: Array<{ seq: number; type: string; data: unknown; createdAt: string; status?: string }> = [];
    const onEvent = (evt: {
      seq: number;
      type: string;
      data: unknown;
      createdAt: string;
      status?: string;
    }) => {
      if (evt.seq > lastSeq) {
        send("event", { seq: evt.seq, type: evt.type, data: evt.data, createdAt: evt.createdAt });
        lastSeq = evt.seq;
      }
      if (evt.status) {
        send("run", { status: evt.status });
      }
    };
    emitter.on("event", (evt) => pending.push(evt));

    // Cap replay to avoid OOM on runs with huge histories; frontend paginates via ?afterSeq if needed
    const sinceSeq = Number(req.query.afterSeq ?? 0);
    const events = await prisma.agentEvent.findMany({
      where: { runId, ...(sinceSeq ? { seq: { gt: sinceSeq } } : {}) },
      orderBy: { seq: "asc" },
      take: 1000,
    });
    send("run", { status: run.status });
    for (const evt of events) {
      send("event", { seq: evt.seq, type: evt.type, data: evt.data, createdAt: evt.createdAt });
    }
    let lastSeq = events.length > 0 ? events[events.length - 1].seq : sinceSeq;
    // Flush buffered live events that arrived during the DB fetch (dedup by seq)
    const seen = new Set(events.map((e) => e.seq));
    for (const evt of pending) {
      if (!seen.has(evt.seq)) onEvent(evt);
    }
    pending.length = 0;
    emitter.removeAllListeners("event");
    emitter.on("event", onEvent);

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      emitter.removeListener("event", onEvent);
      unsubscribeRun(runId, emitter);
    });
  } catch (e) {
    next(e);
  }
});

export default router;
