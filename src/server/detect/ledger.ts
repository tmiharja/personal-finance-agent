import type { TxnKind } from "@/lib/kinds";
import { sql } from "drizzle-orm";
import { sqlRows } from "@/db/rows";
import type { Tx } from "@/db/with-user";

/**
 * What the detectors read (PRD §6.4): every transaction with its merchant,
 * category and card, plus each card's statements. No descriptors: detectors
 * work on merchant names and amounts only.
 */

export type Row = {
  id: string;
  date: string;
  amountCents: number;
  merchant: string;
  /** Lower-cased merchant, the grouping key. */
  key: string;
  kind: TxnKind;
  category: string;
  fxCurrency: string | null;
  fxAmount: string | null;
  accountId: string;
  card: string;
  accountKind: "card" | "deposit";
  /** Paired or marked as a move between your own accounts: never spend (IMP-10). */
  isTransfer: boolean;
  /** The other account of a transfer (e.g. the card a bank payment paid), when known. */
  transferAccountId: string | null;
};

export type StatementRow = {
  accountId: string;
  card: string;
  statementDate: string;
  dueDate: string | null;
  minimumPaymentCents: number | null;
  totalCents: number;
};

export type Ledger = {
  rows: Row[];
  statements: StatementRow[];
  /** Each account's latest statement date: "now" for date-based states of its charges. */
  coverage: Map<string, string>;
};

export async function loadLedger(tx: Tx): Promise<Ledger> {
  const rows = sqlRows<{
    id: string;
    date: string;
    cents: string;
    merchant: string | null;
    kind: Row["kind"];
    category: string | null;
    fx_currency: string | null;
    fx_amount: string | null;
    account_id: string;
    card: string;
    account_kind: "card" | "deposit";
    is_transfer: boolean;
    transfer_account_id: string | null;
  }>(
    await tx.execute(sql`
      select t.is_transfer, t.transfer_account_id, a.kind as account_kind, t.id, t.txn_date::text as date, t.amount_cents::text as cents, t.merchant_name as merchant,
             t.kind, c.name as category, t.fx_currency, t.fx_amount::text as fx_amount,
             t.account_id, case when a.ordinal > 1 then a.product_name || ' (' || a.ordinal || ')' else a.product_name end as card
      from transactions t
      join accounts a on a.id = t.account_id
      left join categories c on c.id = t.category_id
      order by t.txn_date, t.created_at, t.id`),
  );
  const statements = sqlRows<{
    account_id: string;
    card: string;
    statement_date: string;
    due_date: string | null;
    minimum_payment_cents: string | null;
    total_cents: string | null;
    kind: "card" | "deposit";
  }>(
    await tx.execute(sql`
      select a.kind, s.account_id, case when a.ordinal > 1 then a.product_name || ' (' || a.ordinal || ')' else a.product_name end as card,
             s.statement_date::text, s.due_date::text, s.minimum_payment_cents::text, s.total_cents::text
      from statements s join accounts a on a.id = s.account_id
      order by s.statement_date`),
  );
  const coverage = new Map<string, string>();
  for (const s of statements) {
    if ((coverage.get(s.account_id) ?? "") < s.statement_date)
      coverage.set(s.account_id, s.statement_date);
  }
  return {
    rows: rows.map((r) => ({
      id: r.id,
      date: r.date,
      amountCents: Number(r.cents),
      merchant: r.merchant ?? "Unknown",
      key: (r.merchant ?? "unknown").toLowerCase(),
      kind: r.kind,
      category: r.category ?? "Uncategorised",
      fxCurrency: r.fx_currency,
      fxAmount: r.fx_amount,
      accountId: r.account_id,
      card: r.card,
      accountKind: r.account_kind,
      isTransfer: r.is_transfer,
      transferAccountId: r.transfer_account_id,
    })),
    // Due dates and balances to pay: card statements only.
    statements: statements
      .filter((s) => s.kind === "card")
      .map((s) => ({
        accountId: s.account_id,
        card: s.card,
        statementDate: s.statement_date,
        dueDate: s.due_date,
        minimumPaymentCents:
          s.minimum_payment_cents === null ? null : Number(s.minimum_payment_cents),
        totalCents: Number(s.total_cents),
      })),
    coverage,
  };
}

// ------------------------------------------------------------------ dates

export const DAY = 86_400_000;
export const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
export const daysBetween = (a: string, b: string) => Math.round((toTime(b) - toTime(a)) / DAY);
export const addDays = (iso: string, n: number) =>
  new Date(toTime(iso) + n * DAY).toISOString().slice(0, 10);

/** Same day next month(s), clamped to the month's last day. */
export function addMonthsIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function percentile(values: readonly number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}
