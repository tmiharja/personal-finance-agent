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
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The signed-in user's id, validated against the database. */
export async function sessionUserId(request: Request): Promise<string | null> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  return session?.user.id ?? null;
}

export function masterKeys(): MasterKeys {
  return masterKeysFromEnv(getEnv());
}
