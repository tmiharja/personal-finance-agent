import { sql, type SQL } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { usage } from "@/db/schema";
import { withUser, type Tx } from "@/db/with-user";
import { getEnv } from "@/env";
import { costUsd, type TokenUsage } from "./pricing";

export type LlmRoute = "categorise" | "ask";

/** Records one call (or one question's turns) for the user. Counts only. */
export async function recordUsage(
  tx: Tx,
  userId: string,
  route: LlmRoute,
  model: string,
  u: TokenUsage,
  /** Already-priced cost (e.g. summed per turn when models differed). */
  priced?: number,
): Promise<number> {
  const cost = priced ?? costUsd(model, u);
  await tx.insert(usage).values({
    userId,
    route,
    model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    costUsd: cost.toFixed(6),
  });
  return cost;
}

export type BudgetBlock = "global_budget" | "user_budget" | "daily_limit";

// Months and days follow Singapore time, like the rest of the app.
const MONTH_START = sql`(date_trunc('month', now() at time zone 'Asia/Singapore') at time zone 'Asia/Singapore')`;
const DAY_START = sql`(date_trunc('day', now() at time zone 'Asia/Singapore') at time zone 'Asia/Singapore')`;

/**
 * Guardrails before an LLM call (PRD §7.3, OPS-2): the global monthly breaker,
 * the per-user monthly soft cap, and, for Ask, the daily question limit.
 * Returns null when the call may go ahead.
 */
export async function budgetBlock(
  db: AppDb,
  userId: string,
  route: LlmRoute,
  dailyLimit?: number,
): Promise<BudgetBlock | null> {
  const env = getEnv();
  // Across all users, as the owner role: a single sum, no per-user rows leave the query.
  const [global] = sqlRows<{ usd: string }>(
    await db.execute(
      sql`select (
            coalesce((select sum(cost_usd) from usage where created_at >= ${MONTH_START}), 0)
          + coalesce((select sum(cost_usd) from llm_spend_archive
                      where month = (date_trunc('month', now() at time zone 'Asia/Singapore'))::date), 0)
          )::text as usd`,
    ),
  );
  if (Number(global!.usd) >= env.LLM_GLOBAL_MONTHLY_USD) return "global_budget";

  const [mine] = await withUser(db, userId, async (tx) =>
    sqlRows<{ usd: string; asked: number }>(
      await tx.execute(sql`
        select coalesce(sum(cost_usd), 0)::text as usd,
               (count(*) filter (where route = 'ask' and created_at >= ${DAY_START}))::int as asked
        from usage where created_at >= ${MONTH_START}`),
    ),
  );
  if (Number(mine!.usd) >= env.LLM_USER_MONTHLY_USD) return "user_budget";
  if (route === "ask" && mine!.asked >= (dailyLimit ?? env.ASK_DAILY_LIMIT)) return "daily_limit";
  return null;
}

/**
 * Keeps deleted users' LLM spend as monthly totals (no user id), so the global
 * budget breaker still counts it after their usage rows cascade away.
 */
export async function archiveSpend(tx: Tx, who: SQL) {
  await tx.execute(sql`
    insert into llm_spend_archive (month, cost_usd)
    select date_trunc('month', u.created_at at time zone 'Asia/Singapore')::date, sum(u.cost_usd)
    from usage u where ${who}
    group by 1
    on conflict (month) do update set cost_usd = llm_spend_archive.cost_usd + excluded.cost_usd`);
}

/**
 * Moves one user's LLM spend into the archive before their account is
 * deleted: archived and removed in one transaction, so a deletion that fails
 * afterwards (or is retried) can never count the same spend twice.
 */
export async function moveSpendToArchive(tx: Tx, userId: string) {
  await archiveSpend(tx, sql`u.user_id = ${userId}`);
  await tx.execute(sql`delete from usage where user_id = ${userId}`);
}
