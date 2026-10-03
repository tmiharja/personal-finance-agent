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
    const [totals, previous, byCategory, trend] = await Promise.all([
      spendTotals(tx, range),
      prevMonth >= first ? spendTotals(tx, monthRange(prevMonth)) : Promise.resolve(null),
      spendByCategory(tx, range),
      monthlySpend(tx, { from: monthRange(addMonths(month, -11)).from, to: range.to }),
    ]);
    return { month, span: { first, last }, totals, previous, byCategory, trend };
  });
}
