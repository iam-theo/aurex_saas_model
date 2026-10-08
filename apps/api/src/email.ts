import nodemailer from "nodemailer";

const SMTP_HOST = process.env.BREVO_SMTP_HOST ?? "smtp-relay.brevo.com";
const SMTP_PORT = Number(process.env.BREVO_SMTP_PORT ?? 587);
const SMTP_USER = process.env.BREVO_SMTP_USER ?? "";
const SMTP_PASS = process.env.BREVO_SMTP_PASS ?? "";
const FROM_NAME = process.env.BREVO_FROM_NAME ?? "Aurex";
const FROM_EMAIL = process.env.BREVO_FROM_EMAIL ?? "";

export const EMAIL_CONFIGURED = Boolean(SMTP_USER && SMTP_PASS && FROM_EMAIL);

const transporter = EMAIL_CONFIGURED
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false, // STARTTLS on port 587
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

export interface SendResult {
  ok: boolean;
  error?: string;
}

export async function sendMail(to: string, subject: string, html: string, text?: string): Promise<SendResult> {
  if (!transporter) return { ok: false, error: "SMTP not configured (BREVO_* env not set)" };
  try {
    await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to,
      subject,
      html,
      text: text ?? html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    });
    return { ok: true };
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    console.error("[email] send failed:", message);
    return { ok: false, error: message };
  }
}

/** The user-facing verification link (lands on the SPA /auth/verify route). */
export function verificationUrl(token: string): string {
  const base = (process.env.AUREX_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return `${base}/auth/verify?token=${encodeURIComponent(token)}`;
}

export async function sendVerificationEmail(to: string, name: string, token: string): Promise<SendResult> {
  const url = verificationUrl(token);
  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a2333">
  <h1 style="font-size:22px;margin:0 0 8px">Confirm your email</h1>
  <p style="font-size:15px;line-height:1.6;color:#46536b">Hi ${name.replace(/[<>&]/g, "")},<br/>
  Welcome to <strong>Aurex</strong>. Verify your email address to finish creating your account.</p>
  <p style="margin:28px 0;text-align:center">
    <a href="${url}" style="display:inline-block;padding:13px 26px;border-radius:8px;background:#3b82f6;color:#fff;text-decoration:none;font-weight:bold">Verify email</a>
  </p>
  <p style="font-size:13px;color:#6b7688">If the button doesn't work, copy this link:<br/><span style="word-break:break-all">${url}</span></p>
  <p style="font-size:12px;color:#9aa4b5;margin-top:24px">This link expires in 24 hours. If you didn't request this, you can ignore this email.</p>
</div>`;
  return sendMail(to, "Confirm your email — Aurex", html);
}