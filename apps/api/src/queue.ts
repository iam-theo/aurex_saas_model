import { Queue } from "bullmq";
import { REDIS_URL } from "./config.js";

// BullMQ requires maxRetriesPerRequest: null for blocking commands (BRPOPLPUSH)
export const connectionOpts = { url: REDIS_URL, maxRetriesPerRequest: null as unknown as number };

export const runQueue = new Queue("agent-runs", { connection: connectionOpts });

export const WORKSPACE_JOB = {
  Ensure: "workspace-ensure",
  Start: "workspace-start",
  Stop: "workspace-stop",
} as const;

export const workspaceQueue = new Queue("workspace-jobs", { connection: connectionOpts });

export async function enqueueRun(runId: string, promptId?: string) {
  await runQueue.add("run", { runId, promptId }, { removeOnComplete: 100, removeOnFail: 100, attempts: 3, backoff: { type: "exponential", delay: 4000 } });
}

export async function enqueueRetry(runId: string) {
  await runQueue.add("retry", { runId }, { removeOnComplete: 50, removeOnFail: 50, attempts: 2, backoff: { type: "exponential", delay: 2000 } });
}

export const chatQueue = new Queue("agent-chat", { connection: connectionOpts });

export const publishQueue = new Queue("publish-jobs", { connection: connectionOpts });

export async function enqueuePublish(projectId: string, userId?: string, slug?: string) {
  // Use random suffix to avoid collision within same ms; also dedup via jobId prefix
  const suffix = Math.random().toString(36).slice(2, 8);
  await publishQueue.add(
    "publish",
    { projectId, userId, slug },
    { removeOnComplete: 20, removeOnFail: 20, attempts: 1, jobId: `publish-${projectId}-${Date.now()}-${suffix}` },
  );
}

export async function enqueueChat(runId: string, text: string, attachmentIds: string[] = []) {
  await chatQueue.add("chat", { runId, text, attachmentIds }, { removeOnComplete: 100, removeOnFail: 100, attempts: 3, backoff: { type: "exponential", delay: 2000 } });
}

export async function enqueueQuestionAnswer(runId: string, requestId: string, answers: string[][]) {
  await chatQueue.add("question", { runId, requestId, answers }, { removeOnComplete: 100, removeOnFail: 100, attempts: 3, backoff: { type: "exponential", delay: 2000 } });
}

export async function enqueueAbort(runId: string) {
  await chatQueue.add("abort", { runId }, { removeOnComplete: 100, removeOnFail: 100 });
}
