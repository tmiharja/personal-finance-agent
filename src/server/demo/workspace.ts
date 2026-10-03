import { createHmac } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { demoQuota, user } from "@/db/schema";
import { getEnv } from "@/env";
import type { MasterKeys } from "@/server/crypto/envelope";
import { logEvent } from "@/server/log";
import { seedDemoWorkspace } from "./seed";

/**
 * "Try the demo" (PRD AUTH-6): a no-signup workspace with the fictional Alex
 * Tan's statements, read-only for imports, with Ask capped per visitor per day,
 * deleted after 24 hours.
 */

export const DEMO_TTL_MS = 24 * 60 * 60 * 1000;

/** Today in Singapore (the quota day). */
const quotaDay = (now = new Date()) =>
  new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

/**
 * A per-visitor key that stores no IP address: an HMAC of the client IP under a
 * secret that changes every day, so keys can't be reversed or linked across days.
 */
export function visitorKey(request: Request, day = quotaDay()): string {
  const ip =
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const secret = getEnv().BETTER_AUTH_SECRET ?? "dev-only-secret-not-for-production-use";
  const dayKey = createHmac("sha256", secret).update(`demo-quota:${day}`).digest();
  return createHmac("sha256", dayKey).update(ip).digest("hex");
}

/** Counts one use against today's limit. False when the limit is already reached. */
export async function consumeDemoQuota(
  db: AppDb,
  key: string,
  field: "workspaces" | "questions",
  limit: number,
): Promise<boolean> {
  const day = quotaDay();
  const column = field === "workspaces" ? demoQuota.workspaces : demoQuota.questions;
  const [row] = await db
    .insert(demoQuota)
    .values({ key, day, [field]: 1 })
    .onConflictDoUpdate({
      target: [demoQuota.key, demoQuota.day],
      set: { [field]: sql`${column} + 1` },
    })
    .returning({ used: column });
  return (row?.used ?? 0) <= limit;
}

export async function isDemoUser(db: AppDb, userId: string): Promise<boolean> {
  const [u] = await db.select({ anon: user.isAnonymous }).from(user).where(eq(user.id, userId));
  return u?.anon === true;
}

/** Seeds a new anonymous user's workspace (same write path as a real import). */
export async function prepareDemoWorkspace(db: AppDb, userId: string, keys: MasterKeys) {
  const result = await seedDemoWorkspace(db, userId, keys);
  logEvent("demo.created", { transactions: result.transactions });
  return result;
}

/**
 * Daily cron: deletes demo users older than 24 hours with everything they own
 * (cascades). Their LLM spend is kept as a monthly total first, so the global
 * budget breaker still counts it.
 */
export async function deleteExpiredDemos(db: AppDb, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DEMO_TTL_MS);
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into llm_spend_archive (month, cost_usd)
      select date_trunc('month', u.created_at at time zone 'Asia/Singapore')::date, sum(u.cost_usd)
      from usage u join "user" x on x.id = u.user_id
      where x.is_anonymous and x.created_at < ${cutoff}
      group by 1
      on conflict (month) do update set cost_usd = llm_spend_archive.cost_usd + excluded.cost_usd`);
    const gone = await tx
      .delete(user)
      .where(and(eq(user.isAnonymous, true), lt(user.createdAt, cutoff)))
      .returning({ id: user.id });
    // Old quota rows are no longer needed.
    await tx
      .delete(demoQuota)
      .where(lt(demoQuota.day, quotaDay(new Date(now.getTime() - 2 * DEMO_TTL_MS))));
    return gone.length;
  });
}

export async function demoCount(db: AppDb): Promise<number> {
  const [r] = sqlRows<{ n: number }>(
    await db.execute(sql`select count(*)::int as n from "user" where is_anonymous`),
  );
  return r?.n ?? 0;
}
