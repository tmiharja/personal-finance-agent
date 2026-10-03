import { sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { withUser } from "@/db/with-user";
import { sqlRows } from "@/db/rows";

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
        (select count(*)::int from proposed_actions where status = 'pending') as "pendingApprovals"`);
    return sqlRows<OverviewCounts>(res)[0]!;
  });
}
