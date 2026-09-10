import express from "express";
import cors from "cors";
import { API_PORT } from "./config.js";
import { requireAuth } from "./auth.js";
import authRouter from "./routes/auth.js";
import projectsRouter from "./routes/projects.js";
import workspacesRouter from "./routes/workspaces.js";
import runsRouter from "./routes/runs.js";
import modelsRouter from "./routes/models.js";
import filesRouter from "./routes/files.js";
import importRouter from "./routes/import.js";
import attachmentsRouter from "./routes/attachments.js";
import previewRouter from "./routes/preview.js";
import artifactsRouter from "./routes/artifacts.js";
import promptsRouter from "./routes/prompts.js";

const app = express();
// Only trust the first hop (nginx). "true" trusts X-Forwarded-For from any client and lets attackers spoof req.ip to bypass rate limits.
app.set("trust proxy", 1);
const ALLOWED_ORIGINS = (process.env.AUREX_ALLOWED_ORIGINS ?? process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const isOrigAllowed = (origin?: string) => {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.length === 0) {
    // In production require explicit allow-list; default to allow known prod origins if not configured
    if (process.env.NODE_ENV !== "production") return true;
    // Fallback for legacy deploys without explicit config
    return false;
  }
  return ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes("*");
};
app.use(cors({
  origin: (origin, cb) => cb(null, isOrigAllowed(origin)),
  credentials: true,
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","X-Aurex-Internal"],
}));
app.use(express.json({ limit: "2mb" }));
// Security headers (lightweight helmet subset — avoid extra dep)
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  next();
});
// Distributed Redis rate limiting (works multi-instance, not spoofable beyond nginx)
import Redis from "ioredis";
import { REDIS_URL } from "./config.js";
const rateRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: true });
rateRedis.on("error", (e) => console.error("[rate-limit] redis error:", (e as Error).message));
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.API_RATE_LIMIT ?? 120);
const RATE_WINDOW_S = Math.ceil(RATE_WINDOW_MS / 1000);
app.use(async (req, res, next) => {
  if (req.path === "/api/health" || req.path.includes("/events")) { next(); return; }
  // Skip rate-limit for internal publish callbacks (worker -> API) and health-like routes
  if (req.path.startsWith("/api/projects/publish/setup") || req.headers["x-aurex-internal"]) { next(); return; }
  const key = `aurex:ratelimit:${req.ip ?? "unknown"}`;
  try {
    if (rateRedis.status !== "ready" && rateRedis.status !== "connecting") await rateRedis.connect().catch(() => {});
    // Pipeline INCR + TTL + conditional EXPIRE to reduce RTTs from 3 to 1
    const pipeline = rateRedis.pipeline();
    pipeline.incr(key);
    pipeline.ttl(key);
    const results = await pipeline.exec();
    const count = (results?.[0]?.[1] as number) ?? 1;
    const ttl = (results?.[1]?.[1] as number) ?? -1;
    if (count === 1 || ttl === -1) {
      // First hit or no expiry set — set it (fire-and-forget, don't await)
      rateRedis.expire(key, RATE_WINDOW_S).catch(() => {});
    }
    if (count > RATE_MAX) {
      const retryAfter = ttl > 0 ? ttl : RATE_WINDOW_S;
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "too many requests — slow down" });
      return;
    }
  } catch {
    // Fail open if Redis unavailable
  }
  next();
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "aurex-api" }));
app.get("/api/config", (_req, res) => {
  const publishDomain = (() => {
    if (process.env.AUREX_PUBLISH_DOMAIN) return process.env.AUREX_PUBLISH_DOMAIN.trim().replace(/^\.+/, "");
    const base = process.env.AUREX_PUBLIC_BASE_URL;
    if (base) try { const h = new URL(base).hostname; const p = h.split("."); if (p.length >= 2) return p.slice(-2).join("."); return h; } catch {}
    return "";
  })();
  res.json({ publishDomain, publicBaseUrl: process.env.AUREX_PUBLIC_BASE_URL ?? null });
});

// OAuth endpoints must be reachable before the auth gate.
app.use("/api/auth", authRouter);

// Everything below requires a valid session (when auth is enabled).
app.use("/api", requireAuth);

app.use("/api/projects", projectsRouter);
app.use("/api/workspaces", workspacesRouter);
app.use("/api/runs", runsRouter);
app.use("/api/models", modelsRouter);
app.use("/api/files", attachmentsRouter);
app.use("/api/files", filesRouter);
app.use("/api/preview", previewRouter);
app.use("/api/files", artifactsRouter);
app.use("/api/prompts", promptsRouter);
app.use("/api/import", importRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  const isProd = process.env.NODE_ENV === "production";
  // Never leak internal details (docker stderr, stack) in production
  const httpStatus = (err as unknown as { status?: number; statusCode?: number }).status ?? (err as unknown as { statusCode?: number }).statusCode;
  const message = isProd && !httpStatus ? "Internal server error" : (err.message ?? "Internal server error");
  const status = typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 600 ? httpStatus : 500;
  res.status(status).json({ error: message });
});

app.listen(API_PORT, () => {
  console.log(`[aurex-api] listening on http://localhost:${API_PORT}`);
});
