import { sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { withUser } from "@/db/with-user";
import { sqlRows } from "@/db/rows";
import {
  addMonths,
  dataSpan,
  monthlySpend,
  monthRange,
  spendByCategory,
  spendTotals,
  type CategorySpend,
  type MonthSpend,
  type SpendTotals,
} from "./spend";

export type OverviewCounts = {
  cards: number;
  statements: number;
  transactions: number;
  latestStatement: string | null;
  pendingApprovals: number;
};

/** Counts only (no descriptors), read under the user's RLS scope. */
export async function getOverviewCounts(db: AppDb, userId: string): Promise<OverviewCounts> {
  return withUser(db, userId, async (tx) => {
    const res = await tx.execute(sql`
      select
        (select count(*)::int from accounts where kind = 'card') as cards,
        (select count(*)::int from statements) as statements,
        (select count(*)::int from transactions) as transactions,
        (select max(statement_date)::text from statements) as "latestStatement",
        (select count(*)::int from proposed_actions where status = 'pending' and expires_at > now()) as "pendingApprovals"`);
    return sqlRows<OverviewCounts>(res)[0]!;
  });
}

export type MonthOverview = {
  month: string;
  /** First and last months with data, for the month switcher. */
  span: { first: string; last: string };
  totals: SpendTotals;
  previous: SpendTotals | null;
  byCategory: CategorySpend[];
  /** The 12 months ending at `month`. */
  trend: MonthSpend[];
  /** How many bank accounts are imported (income needs at least one). */
  bankAccounts: number;
  /** Σ closing balances of each bank account's latest statement in or before the month. */
  balances: { cents: number; asOf: string; accounts: number } | null;
};

/** Overview for a month (YYYY-MM); defaults to the latest month with transactions. */
export async function getMonthOverview(
  db: AppDb,
  userId: string,
  requested?: string,
): Promise<MonthOverview | null> {
  return withUser(db, userId, async (tx) => {
    const span = await dataSpan(tx);
    if (!span) return null;
    const first = span.from.slice(0, 7);
    const last = span.to.slice(0, 7);
    const month =
      requested &&
      /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) &&
      requested >= first &&
      requested <= last
        ? requested
        : last;
    const range = monthRange(month);
    const prevMonth = addMonths(month, -1);
    const [totals, previous, byCategory, trend, banks] = await Promise.all([
      spendTotals(tx, range),
      prevMonth >= first ? spendTotals(tx, monthRange(prevMonth)) : Promise.resolve(null),
      spendByCategory(tx, range),
      monthlySpend(tx, { from: monthRange(addMonths(month, -11)).from, to: range.to }),
      tx.execute(sql`select count(*)::int as n from accounts where kind = 'deposit'`),
    ]);
    const bankAccounts = sqlRows<{ n: number }>(banks)[0]?.n ?? 0;
    // Balances are stored signed like rows (money held is negative).
    const [b] = sqlRows<{ cents: string | null; as_of: string | null; n: number }>(
      await tx.execute(sql`
        select (-sum(s.total_cents))::text as cents, max(s.statement_date)::text as as_of, count(*)::int as n
        from (select distinct on (s.account_id) s.total_cents, s.statement_date
              from statements s join accounts a on a.id = s.account_id
              where a.kind = 'deposit' and s.total_cents is not null and s.statement_date <= ${range.to}
              order by s.account_id, s.statement_date desc) s`),
    );
    const balances =
      b?.cents && b.as_of ? { cents: Number(b.cents), asOf: b.as_of, accounts: b.n } : null;
    return {
      month,
      span: { first, last },
      totals,
      previous,
      byCategory,
      trend,
      bankAccounts,
      balances,
    };
  });
}
