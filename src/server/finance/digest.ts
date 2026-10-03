import { sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { withUser } from "@/db/with-user";
import { addDays } from "@/server/detect/ledger";
import { spendByCategory, spendTotals, type CategorySpend } from "./spend";

/**
 * The weekly digest (PRD DET-10), shown in-app: last week's spend against the
 * week before, the categories it went to, alerts raised for that week, and
 * what's due in the next 7 days. Computed when you open Overview, from the
 * same spend definition, so it never disagrees with the rest of the app.
 *
 * "Last week" is the last full Monday-to-Sunday before today (Singapore
 * time). Statements arrive monthly, so the digest says when that week isn't
 * imported yet instead of reporting S$0.
 */

export type WeeklyDigest = {
  week: { from: string; to: string };
  /** False when no transactions are imported for that week yet. */
  imported: boolean;
  /** The last date your data covers. */
  dataTo: string | null;
  spentCents: number;
  count: number;
  previousCents: number;
  /** Change against the week before, as a whole percentage (null if that week had none). */
  changePct: number | null;
  topCategories: CategorySpend[];
  alerts: { type: string; subject: string | null; on: string }[];
  dueSoon: { what: string; due: string; cents: number | null }[];
};

/** Monday of the week containing `day` (YYYY-MM-DD). */
export function mondayOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

export async function weeklyDigest(
  db: AppDb,
  userId: string,
  today: string,
): Promise<WeeklyDigest> {
  const from = addDays(mondayOf(today), -7);
  const week = { from, to: addDays(from, 6) };
  const prev = { from: addDays(from, -7), to: addDays(from, -1) };
  const soon = addDays(today, 7);
  return withUser(db, userId, async (tx) => {
    const [now, before, cats] = await Promise.all([
      spendTotals(tx, week),
      spendTotals(tx, prev),
      spendByCategory(tx, week),
    ]);
    const [span] = sqlRows<{ to: string | null }>(
      await tx.execute(sql`select max(txn_date)::text as "to" from transactions`),
    );
    const dataTo = span?.to ?? null;
    const alerts = sqlRows<{ type: string; subject: string | null; on: string }>(
      await tx.execute(sql`
        select type, subject, occurred_on::text as on from alerts
        where occurred_on between ${week.from} and ${week.to} and status = 'open'
        order by occurred_on, type`),
    );
    const due = sqlRows<{ what: string; due: string; cents: string | null }>(
      await tx.execute(sql`
        select c.what, c.due, c.cents from (
          select distinct on (s.account_id)
                 case when a.ordinal > 1 then a.product_name || ' (' || a.ordinal || ')' else a.product_name end as what,
                 s.due_date::text as due, s.total_cents::text as cents, s.statement_date,
                 exists (select 1 from transactions t
                         where (t.account_id = s.account_id or t.transfer_account_id = s.account_id)
                         and t.kind = 'card_payment' and t.txn_date > s.statement_date) as paid
          from statements s join accounts a on a.id = s.account_id
          where a.kind = 'card'
          order by s.account_id, s.statement_date desc) c
        where not c.paid and c.cents::bigint > 0 and c.due between ${today} and ${soon}
        union all
        select payee as what, due_date::text as due, expected_amount_cents::text as cents
        from bills where due_date between ${today} and ${soon} and status <> 'paid'
        order by due`),
    );
    return {
      week,
      imported: dataTo !== null && dataTo >= week.to,
      dataTo,
      spentCents: now.spentCents,
      count: now.count,
      previousCents: before.spentCents,
      changePct:
        before.spentCents > 0
          ? Math.round(((now.spentCents - before.spentCents) / before.spentCents) * 100)
          : null,
      topCategories: cats.filter((c) => c.cents > 0).slice(0, 3),
      alerts,
      dueSoon: due.map((d) => ({
        what: d.what,
        due: d.due,
        cents: d.cents === null ? null : Number(d.cents),
      })),
    };
  });
}
