import { getDb } from "@/db/client";
import { getEnv } from "@/env";
import { expireOverdueForAllUsers } from "@/server/import/service";
import { logEvent } from "@/server/log";

/**
 * Daily (vercel.json): expires overdue import proposals and deletes their
 * encrypted previews for every user. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; without the secret configured, it refuses.
 */
export async function GET(request: Request) {
  const secret = getEnv().CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await expireOverdueForAllUsers(getDb());
  logEvent("cron.expire_imports", result);
  return Response.json(result);
}
