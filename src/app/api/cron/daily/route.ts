import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { getEnv } from "@/env";
import { deleteExpiredDemos } from "@/server/demo/workspace";
import { runDetectors } from "@/server/detect/run";
import { masterKeys } from "@/server/http";
import { expireOverdueForAllUsers } from "@/server/import/service";
import { logError, logEvent } from "@/server/log";

// Detectors run per user; give the daily job room.
export const maxDuration = 300;

/**
 * Daily (vercel.json, 02:07 SGT). Vercel Cron sends `Authorization: Bearer
 * $CRON_SECRET`; without the secret configured, it refuses. It:
 *  - expires overdue proposals and deletes their encrypted previews;
 *  - deletes demo workspaces older than 24 hours;
 *  - re-runs the detectors for everyone with transactions (DET-9), for
 *    date-based states such as "due in 3 days" and "overdue".
 */
export async function GET(request: Request) {
  const secret = getEnv().CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const db = getDb();
  const expired = await expireOverdueForAllUsers(db);
  const demos = await deleteExpiredDemos(db);
  // User ids only, read as the owner; each user's run then happens under their own RLS scope.
  const users = sqlRows<{ id: string }>(
    await db.execute(sql`select distinct user_id as id from transactions`),
  );
  let detected = 0;
  let failed = 0;
  for (const u of users) {
    try {
      await runDetectors(db, u.id, masterKeys());
      detected++;
    } catch (e) {
      failed++;
      logError("cron.detect", e);
    }
  }
  const result = { ...expired, demos, detected, failed };
  logEvent("cron.daily", result);
  return Response.json(result);
}
