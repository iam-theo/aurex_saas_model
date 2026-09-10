// Google OAuth + session auth for Aurex. Zero external dependencies:
// - Sessions are stateless HMAC-SHA256 signed tokens in an httpOnly cookie.
// - The Google OAuth code exchange uses Node's built-in fetch.
//
// Env vars (in ../../.env):
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  — from the Google Cloud OAuth client.
//   SESSION_SECRET                           — used to sign session cookies.
//   AUREX_PUBLIC_BASE_URL                    — optional override for redirect_uri
//                                              (defaults to the request origin).
//
// When GOOGLE_CLIENT_ID/SECRET are not set, auth is DISABLED (all requests pass
// through) so the platform stays usable until OAuth is configured.
import type { NextFunction, Request, Response } from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@aurex/db";
import { WORKSPACE_ROOT } from "@aurex/shared";
import { workspaceQueue, WORKSPACE_JOB } from "./queue.js";
import { WORKSPACE_IMAGE } from "./config.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const SESSION_SECRET = (() => {
  const v = process.env.SESSION_SECRET;
  if (v && v.length >= 16) return v;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production (min 16 chars)");
  }
  console.warn("[auth] SESSION_SECRET not set — using ephemeral dev secret (sessions will not persist across restarts)");
  return `dev-ephemeral-${randomBytes(16).toString("hex")}`;
})();
const PUBLIC_BASE_URL = process.env.AUREX_PUBLIC_BASE_URL ?? "";

export const AUTH_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

const SESSION_COOKIE = "aurex_session";
const SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 days
const OAUTH_STATE_COOKIE = "aurex_oauth_state";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function signSession(userId: string): string {
  const body = b64url(
    Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S })),
  );
  const sig = createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySession(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig) return null;
  const expected = createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      sub?: string;
      exp?: number;
    };
    if (typeof payload.sub !== "string") return null;
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

const _userCache = new Map<string, { user: SessionUser; exp: number }>();
const USER_CACHE_TTL_MS = 60_000;
export function getSessionUser(req: Request): Promise<SessionUser | null> {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return Promise.resolve(null);
  const userId = verifySession(token);
  if (!userId) return Promise.resolve(null);
  const cached = _userCache.get(userId);
  if (cached && cached.exp > Date.now()) return Promise.resolve(cached.user);
  return prisma.user
    .findUnique({ where: { id: userId } })
    .then((u) => {
      const user = u ? { id: u.id, email: u.email, name: u.name, avatarUrl: u.avatarUrl } as SessionUser : null;
      if (user) _userCache.set(userId, { user, exp: Date.now() + USER_CACHE_TTL_MS });
      return user;
    })
    .catch(() => null);
}

function setSessionCookie(res: Response, token: string | null) {
  const secure = reqIsHttps();
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token ?? "")}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${token ? SESSION_TTL_S : 0}`,
  ];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function reqIsHttps(): boolean {
  // The API runs behind nginx on the production host; when a secure public base
  // URL is configured we always mark the cookie Secure.
  return PUBLIC_BASE_URL.startsWith("https://") || process.env.NODE_ENV === "production";
}

/** Express middleware: requires a valid session when auth is enabled. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_ENABLED) {
    next();
    return;
  }
  // Allow internal worker callbacks without session
  const internalKey = process.env.AUREX_INTERNAL_KEY;
  if (internalKey && req.headers["x-aurex-internal"] === internalKey) {
    next();
    return;
  }
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "not authenticated" });
    return;
  }
  req.user = user;
  // Defer workspace ensure to not block every request — only on project/workspace/run routes
  const needsWorkspace = req.path.startsWith("/projects") || req.path.startsWith("/workspaces") || req.path.startsWith("/runs");
  if (needsWorkspace) await ensurePersonalWorkspace(user.id).catch(() => undefined);
  else void ensurePersonalWorkspace(user.id).catch(() => undefined);
  next();
}

/**
 * Every user gets one private Docker workspace. Creates the row on first access
 * and enqueues the container provisioning job; afterwards it's a cheap no-op.
 */
export async function ensurePersonalWorkspace(userId: string) {
  const existing = await prisma.workspace.findUnique({ where: { ownerId: userId } });
  if (existing) return existing;
  const ws = await prisma.workspace.create({
    data: {
      ownerId: userId,
      image: WORKSPACE_IMAGE,
      status: "created",
      path: WORKSPACE_ROOT,
      resourceLimits: { cpus: 2, memory: "4g", pids: 512, timeoutMs: 600000 },
    },
  });
  await workspaceQueue
    .add(
      WORKSPACE_JOB.Ensure,
      { workspaceId: ws.id, resourceLimits: ws.resourceLimits },
      { removeOnComplete: 100, removeOnFail: 100 },
    )
    .catch(() => undefined);
  return ws;
}

/** Compute the OAuth redirect_uri (the callback URL for this request). */
export function oauthRedirectUri(req: Request): string {
  if (PUBLIC_BASE_URL) {
    // Validate that PUBLIC_BASE_URL is an https URL on an allow-listed host (prevent open redirect / state injection)
    try {
      const u = new URL(PUBLIC_BASE_URL);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("invalid scheme");
      return `${u.origin}/api/auth/google/callback`;
    } catch {
      // Fall through to request-derived URL if misconfigured — still safe, but log
      console.warn("[auth] invalid AUREX_PUBLIC_BASE_URL, falling back to request host");
    }
  }
  // In production without PUBLIC_BASE_URL we still derive from trusted proxy 1 — req.secure is based on X-Forwarded-Proto from nginx only now
  const host = req.get("host") ?? "localhost:4010";
  // Validate host header to prevent cache-poisoning / header-injection
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) throw new Error("invalid host header");
  const proto = req.secure ? "https" : "http";
  return `${proto}://${host}/api/auth/google/callback`;
}

function isAllowedNext(next: string): boolean {
  if (!next || next.length > 500) return false;
  if (!/^\/[^\/\\]/.test(next)) return false;
  if (next.includes("\\") || next.includes("//") || /^[a-z]+:\/\//i.test(next)) return false;
  try { const dec = decodeURIComponent(next); if (dec.startsWith("//") || dec.includes("\\")) return false; } catch { return false; }
  return true;
}

export function authStartUrl(req: Request): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: oauthRedirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(
  req: Request,
  code: string,
): Promise<{ user: SessionUser } | { error: string }> {
  const redirect_uri = oauthRedirectUri(req);
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    return { error: `token exchange failed (${tokenRes.status}): ${text.slice(0, 200)}` };
  }
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) return { error: "no access token in token response" };

  const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) return { error: `userinfo failed (${infoRes.status})` };
  const info = (await infoRes.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };
  if (!info.email) return { error: "google account has no email" };

  const googleId = info.sub ?? info.email;
  let user = await prisma.user.findFirst({ where: { OR: [{ googleId }, { email: info.email }] } });
  if (!user) {
    user = await prisma.user.create({
      data: { googleId, email: info.email, name: info.name ?? null, avatarUrl: info.picture ?? null },
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { googleId, email: info.email, name: info.name ?? user.name, avatarUrl: info.picture ?? user.avatarUrl },
    });
  }
  return { user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl } };
}

export function setOAuthStateCookie(res: Response, state: string) {
  const parts = [
    `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=600",
  ];
  if (reqIsHttps()) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

export function readOAuthState(req: Request): string | null {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[OAUTH_STATE_COOKIE] ?? null;
}

export function clearOAuthStateCookie(res: Response) {
  const parts = [
    `${OAUTH_STATE_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (reqIsHttps()) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

export function newOAuthState(): string {
  return randomBytes(16).toString("hex");
}

export function isSessionToken(req: Request): boolean {
  const cookies = parseCookies(req.headers.cookie);
  return Boolean(cookies[SESSION_COOKIE]);
}

export function issueSession(res: Response, userId: string) {
  setSessionCookie(res, signSession(userId));
}

export function clearSession(res: Response) {
  setSessionCookie(res, null);
}
