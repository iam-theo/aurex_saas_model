import { Router } from "express";
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
} from "../auth.js";

const router = Router();

// Current auth state for the SPA (used by the login page + app guard).
router.get("/status", async (req, res, next) => {
  try {
    const user = await getSessionUser(req);
    res.json({
      configured: AUTH_ENABLED,
      authenticated: Boolean(user),
      user,
      redirectUri: AUTH_ENABLED ? oauthRedirectUri(req) : null,
    });
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
    issueSession(res, result.user.id);
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
