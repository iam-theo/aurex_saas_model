import Redis from "ioredis";
import { REDIS_URL } from "./config.js";

const EVENT_CHANNEL = "aurex:agent-events";

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 200, 3000),
  reconnectOnError: () => true,
});
redis.on("error", (e) => console.error("[worker:pubsub] redis error:", (e as Error).message));
redis.on("close", () => console.warn("[worker:pubsub] redis closed — reconnecting"));

function runSeqKey(runId: string) {
  return `aurex:run:${runId}:seq`;
}

/**
 * Allocate the next event sequence number for a run via Redis INCR, shared
 * between API and worker so their writes never collide on seq.
 */
export async function nextRunSeq(runId: string): Promise<number> {
  return redis.incr(runSeqKey(runId));
}

/** Seed the seq counter when a run is created (idempotent). */
export async function initRunSeq(runId: string, maxSeq: number): Promise<void> {
  await redis.set(runSeqKey(runId), maxSeq, "EX", 60 * 60 * 24, "NX");
}

export async function publishRunEvent(evt: {
  runId: string;
  seq: number;
  type: string;
  data: unknown;
  createdAt: string;
  status?: string;
}) {
  try {
    await redis.publish(EVENT_CHANNEL, JSON.stringify(evt));
  } catch (e) {
    console.error("[aurex-worker] redis publish failed:", e);
  }
}

export function redisClient() {
  return redis;
}
