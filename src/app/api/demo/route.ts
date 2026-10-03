import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { user } from "@/db/schema";
import { getAuth } from "@/server/auth/auth";
import { getEnv } from "@/env";
import { consumeDemoQuota, prepareDemoWorkspace, visitorKey } from "@/server/demo/workspace";
import { isSameOrigin, jsonError, masterKeys, sessionUser } from "@/server/http";
import { logError } from "@/server/log";

// Seeding 12 months of statements takes a few seconds on a cold database.
export const maxDuration = 30;

/**
 * "Try the demo": signs the visitor into a fresh anonymous workspace holding the
 * fictional Alex Tan's statements. Limited per visitor per day (default 5).
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return jsonError("bad_origin", 403);
  // Already signed in (a demo or a real account): just go to the workspace.
  if (await sessionUser(request)) return Response.json({ ok: true, existing: true });
  const db = getDb();
  if (
    !(await consumeDemoQuota(
      db,
      visitorKey(request),
      "workspaces",
      getEnv().DEMO_WORKSPACES_PER_DAY,
    ))
  ) {
    return jsonError("demo_limit", 429);
  }
  let userId: string | undefined;
  try {
    const { headers, response } = await getAuth().api.signInAnonymous({
      headers: request.headers,
      returnHeaders: true,
    });
    userId = response?.user.id;
    if (!userId) return jsonError("demo_failed", 500);
    await prepareDemoWorkspace(db, userId, masterKeys());
    const out = Response.json({ ok: true });
    for (const cookie of headers.getSetCookie()) out.headers.append("set-cookie", cookie);
    return out;
  } catch (e) {
    logError("demo.create", e);
    // Never leave a half-seeded workspace behind.
    if (userId)
      await db
        .delete(user)
        .where(eq(user.id, userId))
        .catch(() => undefined);
    return jsonError("demo_failed", 500);
  }
}
