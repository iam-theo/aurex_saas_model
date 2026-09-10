import { EventEmitter } from "node:events";
import Redis from "ioredis";
import { REDIS_URL } from "./config.js";

export interface AgentEventMessage {
  runId: string;
  seq: number;
  type: string;
  data: unknown;
  createdAt: string;
  status?: string;
}

const EVENT_CHANNEL = "aurex:agent-events";

// runId -> Set of client emitters
const clients = new Map<string, Set<EventEmitter>>();
// Lightweight GC for leaked emitters (clients that disconnected without clean close)
setInterval(() => {
  for (const [runId, set] of clients) {
    // Emitters have no native "closed" flag; we track listener count as proxy
    // If set exists but all emitters have 0 listeners, they leaked — remove
    let live = 0;
    for (const em of set) if (em.listenerCount("event") > 0) live++;
    if (live === 0 && set.size > 0) {
      clients.delete(runId);
      console.warn(`[sse] GC leaked emitters for run ${runId} (${set.size} emitters)`);
    }
  }
}, 60_000).unref();

function makeRedis(label: string) {
  const r = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 3000),
    reconnectOnError: () => true,
  });
  r.on("error", (e) => console.error(`[sse:${label}] redis error:`, (e as Error).message));
  r.on("close", () => console.warn(`[sse:${label}] redis closed — reconnecting`));
  return r;
}
const sub = makeRedis("sub");
const pub = makeRedis("pub");

async function resubscribe() {
  try { await sub.subscribe(EVENT_CHANNEL); } catch {}
}
sub.on("ready", resubscribe);
sub.on("reconnecting", () => console.warn("[sse:sub] reconnecting"));
resubscribe();
sub.on("message", (_chan, message) => {
  try {
    const evt = JSON.parse(message) as AgentEventMessage;
    const set = clients.get(evt.runId);
    if (set) {
      for (const emitter of set) {
        emitter.emit("event", evt);
      }
    }
  } catch {
    /* ignore malformed */
  }
});

export function subscribeRun(runId: string): EventEmitter {
  const emitter = new EventEmitter();
  let set = clients.get(runId);
  if (!set) {
    set = new Set();
    clients.set(runId, set);
  }
  set.add(emitter);
  return emitter;
}

export function unsubscribeRun(runId: string, emitter: EventEmitter) {
  const set = clients.get(runId);
  if (!set) return;
  set.delete(emitter);
  if (set.size === 0) clients.delete(runId);
}

export async function publishRunEvent(evt: AgentEventMessage) {
  await pub.publish(EVENT_CHANNEL, JSON.stringify(evt));
}

export async function nextRunSeq(runId: string): Promise<number> {
  return pub.incr(`aurex:run:${runId}:seq`);
}

export async function initRunSeq(runId: string, maxSeq: number): Promise<void> {
  await pub.set(`aurex:run:${runId}:seq`, maxSeq, "EX", 60 * 60 * 24, "NX");
}
