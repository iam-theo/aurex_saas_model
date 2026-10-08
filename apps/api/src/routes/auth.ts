import { Router } from "express";
import { randomBytes } from "node:crypto";
import { prisma } from "@aurex/db";
import { hashPassword, verifyPassword } from "../passwords.js";
import { EMAIL_CONFIGURED, sendVerificationEmail } from "../email.js";
import {
  AUTH_ENABLED,
  authStartUrl,
  clearOAuthStateCookie,
  clearSession,
  ensurePersonalWorkspace,
  exchangeGoogleCode,
  getSessionUser,
  isSessionToken,
  issueSession,
  newOAuthState,
  oauthRedirectUri,
  readOAuthState,
  setOAuthStateCookie,
  signAccessToken,
} from "../auth.js";

const router = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFY_TTL_MS = 1000 * 60 * 60 * 24; // 24h

function normalizeEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function publicUser(u: { id: string; email: string; name: string | null; avatarUrl: string | null }) {
  return { id: u.id, email: u.email, name: u.name, avatarUrl: u.avatarUrl };
}

// Current auth state for the SPA (used by the login page + app guard).
router.get("/status", async (req, res, next) => {
  try {
    const user = await getSessionUser(req);
    res.json({
      configured: AUTH_ENABLED,
      emailAuth: EMAIL_CONFIGURED,
      authenticated: Boolean(user),
      user,
      redirectUri: AUTH_ENABLED ? oauthRedirectUri(req) : null,
    });
  } catch (e) {
    next(e);
  }
});

// --- Email/password signup -------------------------------------------------

// Create an account. The email is not usable until verified (token emailed).
router.post("/signup", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!EMAIL_REGEX.test(email)) {
      res.status(400).json({ error: "Enter a valid email address" });
      return;
    }
    if (name.length < 2) {
      res.status(400).json({ error: "Enter your name (at least 2 characters)" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing?.emailVerified) {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }

    const token = randomBytes(24).toString("hex");
    const expiry = new Date(Date.now() + VERIFY_TTL_MS);
    const passwordHash = await hashPassword(password);

    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: { name, passwordHash, verificationToken: token, verificationExpiry: expiry },
        })
      : await prisma.user.create({
          data: { email, name, passwordHash, emailVerified: false, verificationToken: token, verificationExpiry: expiry },
        });

    const sent = await sendVerificationEmail(email, name, token);
    if (!sent.ok) {
      res.status(502).json({ error: `verification email failed to send: ${sent.error ?? "unknown error"}` });
      return;
    }
    res.status(201).json({ ok: true, email, sent: true });
  } catch (e) {
    next(e);
  }
});

// Sign in with email + password. Requires a verified email.
router.post("/login", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!EMAIL_REGEX.test(email) || !password) {
      res.status(400).json({ error: "Enter your email and password" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    // Same generic message for missing user and bad password (prevents account enumeration).
    if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    if (!user.emailVerified) {
      res.status(403).json({ error: "email_not_verified", email });
      return;
    }

    issueSession(res, user.id, { name: user.name, email: user.email });
    await ensurePersonalWorkspace(user.id).catch(() => undefined);
    res.json({ ok: true, user: publicUser(user), token: signAccessToken(user.id, { name: user.name, email: user.email }) });
  } catch (e) {
    next(e);
  }
});

// Verify a signup email via the link in the email.
router.get("/verify", async (req, res, next) => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!token) {
      res.status(400).json({ error: "Missing verification token" });
      return;
    }
    const user = await prisma.user.findUnique({ where: { verificationToken: token } });
    if (!user || (user.verificationExpiry && user.verificationExpiry.getTime() < Date.now())) {
      res.status(400).json({ error: "This verification link is invalid or has expired — request a new one" });
      return;
    }
    const verified = await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, verificationToken: null, verificationExpiry: null },
    });
    issueSession(res, verified.id, { name: verified.name, email: verified.email });
    await ensurePersonalWorkspace(verified.id).catch(() => undefined);
    res.json({ ok: true, user: publicUser(verified) });
  } catch (e) {
    next(e);
  }
});

// Re-send the verification email (idempotent, no account enumeration).
router.post("/resend-verification", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const user = email && EMAIL_REGEX.test(email) ? await prisma.user.findUnique({ where: { email } }) : null;
    if (!user || user.emailVerified) {
      res.json({ ok: true, sent: false });
      return;
    }
    const token = randomBytes(24).toString("hex");
    await prisma.user.update({
      where: { id: user.id },
      data: { verificationToken: token, verificationExpiry: new Date(Date.now() + VERIFY_TTL_MS) },
    });
    const sent = await sendVerificationEmail(email, user.name ?? "", token);
    if (!sent.ok) {
      res.status(502).json({ error: `verification email failed to send: ${sent.error ?? "unknown error"}` });
      return;
    }
    res.json({ ok: true, sent: true });
  } catch (e) {
    next(e);
  }
});

// Kick off the Google OAuth flow.
router.get("/google", (req, res) => {
  if (!AUTH_ENABLED) {
    res.status(503).json({ error: "Google OAuth is not configured on this server" });
    return;
  }
  const state = newOAuthState();
  setOAuthStateCookie(res, state);
  const url = authStartUrl(req);
  const separator = url.includes("?") ? "&" : "?";
  res.redirect(`${url}${separator}state=${encodeURIComponent(state)}`);
});

// Google redirects here after consent. Exchange the code, sign a session, land
// the user back on the app.
router.get("/google/callback", async (req, res, next) => {
  try {
    if (!AUTH_ENABLED) {
      res.status(503).json({ error: "Google OAuth is not configured on this server" });
      return;
    }
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    if (error) {
      res.status(400).send(`OAuth error: ${error}`);
      return;
    }
    if (typeof code !== "string" || !code) {
      res.status(400).send("missing authorization code");
      return;
    }
    if (typeof state !== "string" || !state || state !== readOAuthState(req)) {
      res.status(400).send("state mismatch — please retry signing in");
      return;
    }
    clearOAuthStateCookie(res);
    const result = await exchangeGoogleCode(req, code);
    if ("error" in result) {
      res.status(502).send(result.error);
      return;
    }
    issueSession(res, result.user.id, result.user);
    // Spawn their private workspace container right after sign-in.
    await ensurePersonalWorkspace(result.user.id).catch(() => undefined);
    const rawNext = typeof req.query.next === "string" ? req.query.next : "";
    // Reject protocol-relative //evil.com, absolute URLs, and encoded variants. Must be a single-leading-slash path.
    const isSafeNext = /^\/[^\/\\]/.test(rawNext) && !rawNext.includes("\\") && !/^[a-z]+:\/\//i.test(rawNext) && !rawNext.includes("//");
    // Extra: decode and re-check to block %2F%2F / %5C encodings
    let decodedOk = true;
    try { const dec = decodeURIComponent(rawNext); if (dec.startsWith("//") || dec.includes("\\")) decodedOk = false; } catch { decodedOk = false; }
    const nextUrl = isSafeNext && decodedOk ? rawNext : "/dashboard";
    res.redirect(nextUrl);
  } catch (e) {
    next(e);
  }
});

// Clear the session cookie.
router.post("/logout", (req, res) => {
  if (isSessionToken(req)) clearSession(res);
  res.json({ ok: true });
});

export default router;