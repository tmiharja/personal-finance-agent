import { getDb } from "@/db/client";
import { getEnv } from "@/env";
import { deleteExpiredDemos } from "@/server/demo/workspace";
import { expireOverdueForAllUsers } from "@/server/import/service";
import { logEvent } from "@/server/log";

/**
 * Daily (vercel.json): expires overdue proposals and deletes their encrypted
 * previews for every user, and deletes demo workspaces older than 24 hours. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; without the secret configured, it refuses.
 */
export async function GET(request: Request) {
  const secret = getEnv().CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const db = getDb();
  const result = { ...(await expireOverdueForAllUsers(db)), demos: await deleteExpiredDemos(db) };
  logEvent("cron.daily", result);
  return Response.json(result);
}
