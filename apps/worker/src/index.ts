import { Worker } from "bullmq";
import { prisma } from "@aurex/db";
import { REDIS_URL, RUN_TIMEOUT_MS } from "./config.js";
import { processAgentRun, processChatMessage, processQuestionAnswer, processAbortRun, retryRun, healOrphanWatchers, activeRuns, QUIET_COMPLETE_MS, type ActiveRunEntry } from "./processRun.js";
import { ensureWorkspace, startWorkspaceById, stopWorkspaceById } from "./workspace.js";
import { publishProject } from "./publish.js";

const connection = { url: REDIS_URL, maxRetriesPerRequest: null };

const AGENT_RUN_CONCURRENCY = Math.max(1, Number(process.env.WORKER_AGENT_CONCURRENCY ?? 4));
const runWorker = new Worker(
  "agent-runs",
  async (job) => {
    const { runId, promptId } = job.data as { runId: string; promptId?: string };
    console.log(`[aurex-worker] processing run ${runId}`);
    if (job.name === "retry") {
      await retryRun(runId);
      return;
    }
    await processAgentRun(runId, promptId);
  },
  { connection, concurrency: AGENT_RUN_CONCURRENCY },
);

const chatWorker = new Worker(
  "agent-chat",
  async (job) => {
    if (job.name === "question") {
      const { runId, requestId, answers } = job.data as {
        runId: string;
        requestId: string;
        answers: string[][];
      };
      console.log(`[aurex-worker] question answer for run ${runId}`);
      await processQuestionAnswer(runId, requestId, answers);
      return;
    }
    if (job.name === "abort") {
      const { runId } = job.data as { runId: string };
      console.log(`[aurex-worker] abort request for run ${runId}`);
      await processAbortRun(runId);
      return;
    }
    const { runId, text, attachmentIds } = job.data as {
      runId: string;
      text: string;
      attachmentIds?: string[];
    };
    console.log(`[aurex-worker] chat message for run ${runId}`);
    await processChatMessage(runId, text, attachmentIds ?? []);
  },
  { connection },
);

const workspaceWorker = new Worker(
  "workspace-jobs",
  async (job) => {
    const { workspaceId, resourceLimits } = job.data as {
      workspaceId: string;
      resourceLimits?: unknown;
    };
    console.log(`[aurex-worker] workspace job ${job.name} for ${workspaceId}`);
    switch (job.name) {
      case "workspace-ensure":
        await ensureWorkspace(workspaceId, resourceLimits as never);
        break;
      case "workspace-start":
        await startWorkspaceById(workspaceId);
        break;
      case "workspace-stop":
        await stopWorkspaceById(workspaceId);
        break;
      default:
        throw new Error(`unknown workspace job: ${job.name}`);
    }
  },
  { connection, concurrency: 2 },
);

const publishWorker = new Worker(
  "publish-jobs",
  async (job) => {
    const { projectId, userId, slug } = job.data as { projectId: string; userId?: string; slug?: string };
    console.log(`[aurex-worker] publish job for ${projectId}`);
    try {
      const { url } = await publishProject(projectId, userId, slug);
      console.log(`[aurex-worker] publish completed ${projectId} -> ${url}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "no_changes") {
        await prisma.project.update({ where: { id: projectId }, data: { publishStatus: null, publishProgress: null } }).catch(() => {});
        return;
      }
      const isTransient =
        msg.includes("DNS did not resolve") ||
        msg.includes("URL returned status") ||
        msg.includes("URL not reachable") ||
        msg.includes("502") ||
        msg.includes("520") ||
        msg.includes("521") ||
        msg.includes("522") ||
        msg.includes("523") ||
        msg.includes("524") ||
        msg.includes("530") ||
        msg.includes("503") ||
        msg.includes("504") ||
        msg.includes("timeout");
      if (isTransient) {
        await prisma.project.update({ where: { id: projectId }, data: { publishStatus: "Verifying DNS…", publishProgress: 95 } }).catch(() => {});
      } else {
        const shortMsg = msg.slice(0, 180);
        await prisma.project.update({ where: { id: projectId }, data: { publishStatus: shortMsg, publishProgress: 0 } }).catch(() => {});
        setTimeout(() => {
          prisma.project.update({ where: { id: projectId }, data: { publishStatus: null, publishProgress: null } }).catch(() => {});
        }, 12000);
      }
      throw e;
    }
  },
  { connection, concurrency: 1 },
);

runWorker.on("failed", async (job, err) => {
  if (job) {
    const { runId } = job.data as { runId: string };
    console.error(`[aurex-worker] run ${runId} failed:`, err);
    const msg = err instanceof Error ? err.message : String(err);
    // Surface to UI as visible error event even if watcher never started
    try {
      const { nextRunSeq, publishRunEvent } = await import("./pubsub.js");
      const seq = await nextRunSeq(runId);
      const createdAt = new Date().toISOString();
      const data = { error: msg, kind: "other", retryable: true, hint: "Click Retry to continue or check logs." };
      await prisma.agentEvent.create({ data: { runId, seq, type: "error", data: data as object, createdAt: new Date(createdAt) } }).catch(() => {});
      await publishRunEvent({ runId, seq, type: "error", data, createdAt }).catch(() => {});
    } catch {}
    await prisma.agentRun
      .update({
        where: { id: runId },
        data: { status: "failed", error: msg.slice(0, 2000), completedAt: new Date() },
      })
      .catch(() => undefined);
    try {
      const { publishRunEvent, nextRunSeq } = await import("./pubsub.js");
      await publishRunEvent({ runId, seq: await nextRunSeq(runId), type: "system", createdAt: new Date().toISOString(), data: { text: `Run failed: ${msg.slice(0, 500)}` }, status: "failed" }).catch(() => {});
    } catch {}
  }
});

runWorker.on("completed", (job) => {
  console.log(`[aurex-worker] run ${job.data.runId} completed`);
});

workspaceWorker.on("failed", (job, err) => {
  if (job) {
    console.error(`[aurex-worker] workspace job ${job.name} failed:`, err);
  }
});

chatWorker.on("failed", async (job, err) => {
  if (job) {
    const { runId } = job.data as { runId: string };
    console.error(`[aurex-worker] chat job for run ${runId} failed:`, err);
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const { nextRunSeq, publishRunEvent } = await import("./pubsub.js");
      const seq = await nextRunSeq(runId);
      const createdAt = new Date().toISOString();
      const data = { error: `Chat failed: ${msg}`, retryable: true };
      await prisma.agentEvent.create({ data: { runId, seq, type: "error", data: data as object, createdAt: new Date(createdAt) } }).catch(() => {});
      await publishRunEvent({ runId, seq, type: "error", data, createdAt }).catch(() => {});
    } catch {}
  }
});

publishWorker.on("failed", (job, err) => {
  console.error(`[aurex-worker] publish job ${job?.data?.projectId} failed:`, err);
});

// Self-heal first, reap second: re-attach watchers for running runs whose
// watcher died (worker restart/crash), then reap only runs that STILL have no
// live in-process watcher and have been running too long. Ordering matters —
// healing first ensures an actively streaming run is never reaped in the
// window between a worker restart and re-attach.
async function healAndReap() {
  try {
    await healOrphanWatchers();
  } catch (e) {
    console.error("[aurex-worker] heal sweep failed:", e);
  }
  try {
    const cutoff = new Date(Date.now() - RUN_TIMEOUT_MS * 2);
    const stale = await prisma.agentRun.findMany({ where: { status: "running", startedAt: { lt: cutoff } }, select: { id: true }, take: 20 });
    for (const r of stale) {
      if (activeRuns.has(r.id)) continue;
      await prisma.agentRun.update({ where: { id: r.id }, data: { status: "timeout", error: `run timed out after ${RUN_TIMEOUT_MS * 2}ms (reaper)`, completedAt: new Date() } }).catch(() => {});
      console.warn(`[aurex-worker] reaped stale run ${r.id}`);
    }
  } catch (e) {
    console.error("[aurex-worker] reaper sweep failed:", e);
  }
}

// Immediate heal on boot: after a crash/restart, live runs must get their
// watchers re-attached before the reaper can time them out.
void healAndReap();

setInterval(() => {
  void healAndReap();
}, 120_000).unref();

// Quiet-completion sweep: a run is done once its agent session has produced no
// events for QUIET_COMPLETE_MS. This drives the "running -> completed" flip even
// when opencode's explicit idle events are never delivered and when the event
// stream itself silently drops — the two failure modes that left chat inputs
// locked behind a permanently-"running" run.
setInterval(() => {
  const now = Date.now();
  for (const [runId, entry] of activeRuns) {
    const e = entry as ActiveRunEntry;
    if (!e.completeIfIdle || !e.lastEventAt) continue;
    if (now - e.lastEventAt > QUIET_COMPLETE_MS) {
      e.lastEventAt = now; // prevent re-firing every tick
      void e.completeIfIdle().catch(() => {});
    }
  }
}, 10_000).unref();

// Retention: prune events beyond 500 per run (keeps DB bounded) — paginated, sampled, and rate-limited
setInterval(async () => {
  try {
    let cursor: string | undefined;
    let processed = 0;
    while (processed < 300) {
      const batch: Array<{ id: string }> = await prisma.agentRun.findMany({
        select: { id: true },
        take: 30,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { id: "asc" },
      });
      if (batch.length === 0) break;
      for (const r of batch) {
        if (processed >= 300) break;
        processed++;
        const count = await prisma.agentEvent.count({ where: { runId: r.id } });
        if (count > 800) {
          const toDelete = await prisma.agentEvent.findMany({ where: { runId: r.id }, orderBy: { seq: "asc" }, take: count - 500, select: { id: true } });
          await prisma.agentEvent.deleteMany({ where: { id: { in: toDelete.map((x) => x.id) } } }).catch(() => {});
        }
        // yield to event loop every 5 runs to avoid starving BullMQ
        if (processed % 5 === 0) await new Promise((res) => setTimeout(res, 50));
      }
      cursor = batch[batch.length - 1].id;
      if (batch.length < 30) break;
    }
  } catch {}
}, 30 * 60_000).unref();

console.log("[aurex-worker] listening for jobs");

async function gracefulShutdown(signal: string) {
  console.log(`[aurex-worker] ${signal} — closing workers`);
  await Promise.allSettled([runWorker.close(), chatWorker.close(), workspaceWorker.close(), publishWorker.close()]);
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
