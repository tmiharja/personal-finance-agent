import { sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { getEnv } from "@/env";
import type { EvalResults } from "@/server/evals/run";
import type { SessionUser } from "@/server/auth/session";
import results from "../../../evals/results.json";

/**
 * The admin page (PRD OPS-3): how the service is doing, never anyone's money.
 * Every figure is a count or a cost, aggregated across users as the owner
 * role; demo workspaces are left out of the user and import figures.
 */

export function isAdmin(
  user: Pick<SessionUser, "email" | "isDemo">,
  emails = getEnv().ADMIN_EMAILS,
): boolean {
  const list = (emails ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return !user.isDemo && list.includes(user.email.toLowerCase());
}

export type AdminStats = {
  users: { total: number; last30: number; demos: number };
  imports: { bank: string; committed: number; ai: number }[];
  parsing: { method: string; outcome: string; n: number }[];
  reconciliation: { reconciled: number; unreconciled: number; unchecked: number };
  cost: {
    month: string;
    byRoute: { route: string; usd: number; calls: number }[];
    archivedUsd: number;
    totalUsd: number;
    budgetUsd: number;
  };
  evals: EvalResults & { generatedOn: string };
};

const REAL_USER = sql`not coalesce(u.is_anonymous, false)`;

export async function getAdminStats(db: AppDb): Promise<AdminStats> {
  const [users] = sqlRows<{ total: number; last30: number; demos: number }>(
    await db.execute(sql`
      select count(*) filter (where ${REAL_USER})::int as total,
             count(*) filter (where ${REAL_USER} and u.created_at >= now() - interval '30 days')::int as last30,
             count(*) filter (where not ${REAL_USER})::int as demos
      from "user" u`),
  );
  const imports = sqlRows<{ bank: string; committed: number; ai: number }>(
    await db.execute(sql`
      select i.bank::text as bank, count(*)::int as committed,
             count(*) filter (where i.parser_version like 'ai-%')::int as ai
      from imports i join "user" u on u.id = i.user_id
      where i.status = 'committed' and ${REAL_USER}
      group by 1 order by 2 desc, 1`),
  );
  const parsing = sqlRows<{ method: string; outcome: string; n: number }>(
    await db.execute(sql`
      select method, outcome, sum(n)::int as n from parse_stats
      where day >= current_date - 30 group by 1, 2 order by 1, 3 desc`),
  );
  const [rec] = sqlRows<{ reconciled: number; unreconciled: number; unchecked: number }>(
    await db.execute(sql`
      select count(*) filter (where s.reconciled)::int as reconciled,
             count(*) filter (where not s.reconciled)::int as unreconciled,
             count(*) filter (where s.reconciled is null)::int as unchecked
      from statements s join "user" u on u.id = s.user_id where ${REAL_USER}`),
  );
  const month = sql`(date_trunc('month', now() at time zone 'Asia/Singapore') at time zone 'Asia/Singapore')`;
  const byRoute = sqlRows<{ route: string; usd: string; calls: number }>(
    await db.execute(sql`
      select route, sum(cost_usd)::text as usd, count(*)::int as calls
      from usage where created_at >= ${month} group by 1 order by 1`),
  ).map((r) => ({ route: r.route, usd: Number(r.usd), calls: r.calls }));
  const [archived] = sqlRows<{ usd: string }>(
    await db.execute(sql`
      select coalesce(sum(cost_usd), 0)::text as usd from llm_spend_archive
      where month = (date_trunc('month', now() at time zone 'Asia/Singapore'))::date`),
  );
  const archivedUsd = Number(archived?.usd ?? 0);
  return {
    users: users!,
    imports,
    parsing,
    reconciliation: rec!,
    cost: {
      month: new Date().toISOString().slice(0, 7),
      byRoute,
      archivedUsd,
      totalUsd: byRoute.reduce((s, r) => s + r.usd, 0) + archivedUsd,
      budgetUsd: getEnv().LLM_GLOBAL_MONTHLY_USD,
    },
    evals: results as AdminStats["evals"],
  };
}
