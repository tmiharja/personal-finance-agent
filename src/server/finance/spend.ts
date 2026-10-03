import { sql, type SQL } from "drizzle-orm";
import { sqlRows } from "@/db/rows";
import type { Tx } from "@/db/with-user";

/**
 * One definition of "spend", shared by Overview and Ask (PRD ASK-6) so the two
 * can never disagree:
 *  - spend = charges + fees, with refunds netted against their category;
 *  - card payments (transfers) and cashback are excluded, and counted separately
 *    so every answer can say what it left out.
 * Periods are inclusive transaction-date ranges (YYYY-MM-DD). Every function
 * runs inside withUser(), so RLS scopes it to one user.
 */

export type Range = { from: string; to: string };
export type Scope = { account?: string; category?: string; merchant?: string };

const SPEND_KINDS = sql`t.kind in ('charge', 'fee', 'refund')`;

function scopeSql(scope: Scope = {}): SQL {
  const parts: SQL[] = [sql`true`];
  if (scope.account) parts.push(sql`t.account_id = ${scope.account}`);
  if (scope.category) parts.push(sql`coalesce(c.name, 'Uncategorised') = ${scope.category}`);
  if (scope.merchant) parts.push(sql`lower(t.merchant_name) = lower(${scope.merchant})`);
  return sql.join(parts, sql` and `);
}

const inRange = (r: Range) => sql`t.txn_date between ${r.from} and ${r.to}`;

export type SpendTotals = {
  spentCents: number;
  /** Refunds already netted into spentCents (a negative number). */
  refundsCents: number;
  /** Rows counted in spend. */
  count: number;
  cashbackCents: number;
  cardPaymentsCents: number;
  excluded: { cardPayments: number; cashback: number };
};

export async function spendTotals(tx: Tx, range: Range, scope: Scope = {}): Promise<SpendTotals> {
  const [r] = sqlRows<{
    spent: string;
    refunds: string;
    n: number;
    cashback: string;
    payments: string;
    n_payments: number;
    n_cashback: number;
  }>(
    await tx.execute(sql`
      select
        coalesce(sum(t.amount_cents) filter (where ${SPEND_KINDS}), 0)::text as spent,
        coalesce(sum(t.amount_cents) filter (where t.kind = 'refund'), 0)::text as refunds,
        (count(*) filter (where ${SPEND_KINDS}))::int as n,
        coalesce(sum(t.amount_cents) filter (where t.kind = 'cashback'), 0)::text as cashback,
        coalesce(sum(t.amount_cents) filter (where t.kind = 'card_payment'), 0)::text as payments,
        (count(*) filter (where t.kind = 'card_payment'))::int as n_payments,
        (count(*) filter (where t.kind = 'cashback'))::int as n_cashback
      from transactions t left join categories c on c.id = t.category_id
      where ${inRange(range)} and ${scopeSql(scope)}`),
  );
  return {
    spentCents: Number(r!.spent),
    refundsCents: Number(r!.refunds),
    count: r!.n,
    cashbackCents: Number(r!.cashback),
    cardPaymentsCents: Number(r!.payments),
    excluded: { cardPayments: r!.n_payments, cashback: r!.n_cashback },
  };
}

export type CategorySpend = { category: string; cents: number; count: number };

/**
 * Spend per category, largest first. A category whose refunds exceed its charges
 * is kept (negative), so the categories always add up to the spend total.
 */
export async function spendByCategory(
  tx: Tx,
  range: Range,
  scope: Omit<Scope, "category"> = {},
): Promise<CategorySpend[]> {
  const rows = sqlRows<{ category: string; cents: string; n: number }>(
    await tx.execute(sql`
      select coalesce(c.name, 'Uncategorised') as category,
             sum(t.amount_cents)::text as cents, count(*)::int as n
      from transactions t left join categories c on c.id = t.category_id
      where ${inRange(range)} and ${SPEND_KINDS} and ${scopeSql(scope)}
      group by 1 order by sum(t.amount_cents) desc, 1`),
  );
  return rows
    .map((r) => ({ category: r.category, cents: Number(r.cents), count: r.n }))
    .filter((r) => r.cents !== 0);
}

export type MonthSpend = { month: string; cents: number };

/** Spend per calendar month (YYYY-MM) in the range, including empty months. */
export async function monthlySpend(tx: Tx, range: Range, scope: Scope = {}): Promise<MonthSpend[]> {
  const rows = sqlRows<{ month: string; cents: string }>(
    await tx.execute(sql`
      select to_char(m, 'YYYY-MM') as month, coalesce(sum(t.amount_cents), 0)::text as cents
      from generate_series(date_trunc('month', ${range.from}::date), date_trunc('month', ${range.to}::date), interval '1 month') m
      left join (transactions t left join categories c on c.id = t.category_id)
        on date_trunc('month', t.txn_date) = m and ${SPEND_KINDS} and ${inRange(range)} and ${scopeSql(scope)}
      group by m order by m`),
  );
  return rows.map((r) => ({ month: r.month, cents: Number(r.cents) }));
}

export type MerchantSpend = { merchant: string; cents: number; count: number };

export async function topMerchants(
  tx: Tx,
  range: Range,
  scope: Scope = {},
  limit = 10,
): Promise<MerchantSpend[]> {
  const rows = sqlRows<{ merchant: string; cents: string; n: number }>(
    await tx.execute(sql`
      select coalesce(t.merchant_name, 'Unknown') as merchant,
             sum(t.amount_cents)::text as cents, count(*)::int as n
      from transactions t left join categories c on c.id = t.category_id
      where ${inRange(range)} and ${SPEND_KINDS} and ${scopeSql(scope)}
      group by 1 having sum(t.amount_cents) > 0
      order by sum(t.amount_cents) desc, 1 limit ${limit}`),
  );
  return rows.map((r) => ({ merchant: r.merchant, cents: Number(r.cents), count: r.n }));
}

/** First and last transaction dates, or null for an empty ledger. */
export async function dataSpan(tx: Tx): Promise<Range | null> {
  const [r] = sqlRows<{ from: string | null; to: string | null }>(
    await tx.execute(
      sql`select min(txn_date)::text as "from", max(txn_date)::text as "to" from transactions`,
    ),
  );
  return r?.from && r.to ? { from: r.from, to: r.to } : null;
}

export function monthRange(month: string): Range {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
