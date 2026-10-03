import { getEnv } from "@/env";
import { getAuth } from "@/server/auth/auth";
import { masterKeysFromEnv, type MasterKeys } from "@/server/crypto/envelope";

export const jsonError = (code: string, status: number) =>
  Response.json({ error: code }, { status });

/** Mutations must come from this site (PRD §7.1: same-origin checks). */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  // Compare with the host the browser addressed (forwarded by Vercel's proxy);
  // request.url can carry the server's bind address instead.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    // Scheme too: an http:// origin must not pass for an https:// request.
    const proto =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      new URL(request.url).protocol.replace(":", "");
    const o = new URL(origin);
    return !!host && o.host === host && o.protocol === `${proto}:`;
  } catch {
    return false;
  }
}

/** The signed-in user's id, validated against the database. */
export async function sessionUserId(request: Request): Promise<string | null> {
  return (await sessionUser(request))?.id ?? null;
}

/** Sensitive actions (export, account deletion) need a sign-in this recent (AUTH-3). */
export const FRESH_SESSION_MS = 10 * 60 * 1000;

/** The signed-in user, whether it's a demo workspace, and whether the sign-in is recent. */
export async function sessionUser(
  request: Request,
): Promise<{ id: string; isDemo: boolean; fresh: boolean } | null> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return null;
  return {
    id: session.user.id,
    isDemo: (session.user as { isAnonymous?: boolean | null }).isAnonymous === true,
    fresh: Date.now() - new Date(session.session.createdAt).getTime() < FRESH_SESSION_MS,
  };
}

export function masterKeys(): MasterKeys {
  return masterKeysFromEnv(getEnv());
}
