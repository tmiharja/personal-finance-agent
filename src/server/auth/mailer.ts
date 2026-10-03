import { Resend } from "resend";
import { getEnv } from "@/env";
import { logError, logEvent } from "@/server/log";

/**
 * Delivers sign-in codes. Production: Resend. Dev and e2e: an in-memory outbox
 * (DEV_MAIL_OUTBOX=1, refused on any deployment) so tests can read the code; the
 * code is never logged.
 */

// Codes expire like the real ones (5 minutes) and can be read once.
const OUTBOX_TTL_MS = 5 * 60 * 1000;
const outbox = new Map<string, { code: string; expiresAt: number }>();

export function readDevOutbox(email: string): string | undefined {
  const key = email.toLowerCase();
  const entry = outbox.get(key);
  outbox.delete(key);
  return entry && entry.expiresAt > Date.now() ? entry.code : undefined;
}

export async function sendSignInCode(email: string, code: string): Promise<void> {
  const env = getEnv();
  if (env.DEV_MAIL_OUTBOX && !env.isDeployed) {
    const now = Date.now();
    for (const [k, v] of outbox) if (v.expiresAt <= now) outbox.delete(k);
    outbox.set(email.toLowerCase(), { code, expiresAt: now + OUTBOX_TTL_MS });
    logEvent("auth.code_sent", { channel: "dev_outbox" });
    return;
  }
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    logEvent("auth.code_not_sent", { reason: "email_not_configured" });
    return;
  }
  try {
    await new Resend(env.RESEND_API_KEY).emails.send({
      from: env.EMAIL_FROM,
      to: email,
      subject: `Your sign-in code: ${code}`,
      text: `Your Finance Agent sign-in code is ${code}. It expires in 5 minutes.\n\nIf you didn't ask for it, you can ignore this email.`,
    });
    logEvent("auth.code_sent", { channel: "resend" });
  } catch (e) {
    logError("auth.send_code", e);
  }
}
