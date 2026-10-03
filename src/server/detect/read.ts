import { desc, eq, inArray, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { alerts, bills, subscriptions, transactions } from "@/db/schema";
import { withUser } from "@/db/with-user";
import { PER_MONTH, type Cadence } from "./recurring";

/** Read side of the detectors for the screens and Ask. RLS-scoped; no descriptors. */

export type SubscriptionView = {
  id: string;
  merchant: string;
  cadence: Cadence;
  amountCents: number;
  monthlyCents: number;
  charges: number;
  firstChargeDate: string | null;
  lastChargeDate: string | null;
  nextExpectedDate: string | null;
  status: "active" | "possibly_cancelled" | "overdue" | "ignored";
  previousAmountCents: number | null;
  priceChangedOn: string | null;
  ignored: boolean;
};

export async function listSubscriptions(
  db: AppDb,
  userId: string,
  { includeIgnored = false } = {},
): Promise<{ items: SubscriptionView[]; monthlyCents: number }> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.select().from(subscriptions).orderBy(desc(subscriptions.amountCents));
    const items = rows
      .filter((r) => includeIgnored || !r.ignored)
      .map((r) => ({
        id: r.id,
        merchant: r.merchantName,
        cadence: r.cadence,
        amountCents: r.amountCents,
        monthlyCents: Math.round(r.amountCents * PER_MONTH[r.cadence]),
        charges: r.charges,
        firstChargeDate: r.firstChargeDate,
        lastChargeDate: r.lastChargeDate,
        nextExpectedDate: r.nextExpectedDate,
        status: r.ignored ? ("ignored" as const) : r.status,
        previousAmountCents: r.previousAmountCents,
        priceChangedOn: r.priceChangedOn,
        ignored: r.ignored,
      }))
      .sort((a, b) => b.monthlyCents - a.monthlyCents);
    // The monthly total counts what's still running.
    const monthlyCents = items
      .filter((s) => s.status === "active" || s.status === "overdue")
      .reduce((sum, s) => sum + s.monthlyCents, 0);
    return { items, monthlyCents };
  });
}

export type CardDue = {
  accountId: string;
  card: string;
  statementDate: string;
  dueDate: string | null;
  minimumPaymentCents: number | null;
  totalCents: number;
  /** A card payment appears after the statement date (in a later statement). */
  paid: boolean;
};

export type BillView = {
  id: string;
  payee: string;
  card: string | null;
  dueDay: number | null;
  nextDueDate: string | null;
  expectedAmountCents: number | null;
  lastAmountCents: number | null;
  lastPaidOn: string | null;
  status: "upcoming" | "paid" | "overdue";
};

/** DET-6 and DET-7: each card's latest statement due, plus detected recurring bills. */
export async function listBills(
  db: AppDb,
  userId: string,
): Promise<{ cards: CardDue[]; bills: BillView[] }> {
  return withUser(db, userId, async (tx) => {
    const cards = sqlRows<{
      account_id: string;
      card: string;
      statement_date: string;
      due_date: string | null;
      min: string | null;
      total: string;
      paid: boolean;
    }>(
      await tx.execute(sql`
        select distinct on (s.account_id) s.account_id,
               case when a.ordinal > 1 then a.product_name || ' (' || a.ordinal || ')' else a.product_name end as card,
               s.statement_date::text, s.due_date::text, s.minimum_payment_cents::text as min, s.total_cents::text as total,
               exists (select 1 from transactions t
                       where (t.account_id = s.account_id or t.transfer_account_id = s.account_id)
                       and t.kind = 'card_payment' and t.txn_date > s.statement_date) as paid
        from statements s join accounts a on a.id = s.account_id
        where a.kind = 'card'
        order by s.account_id, s.statement_date desc`),
    );
    const found = await tx
      .select({
        id: bills.id,
        payee: bills.payee,
        accountId: bills.accountId,
        dueDay: bills.dueDay,
        dueDate: bills.dueDate,
        expected: bills.expectedAmountCents,
        last: bills.lastAmountCents,
        lastPaidOn: bills.lastPaidOn,
        status: bills.status,
      })
      .from(bills)
      .orderBy(bills.dueDate);
    const cardName = new Map(cards.map((c) => [c.account_id, c.card]));
    return {
      cards: cards
        .map((c) => ({
          accountId: c.account_id,
          card: c.card,
          statementDate: c.statement_date,
          dueDate: c.due_date,
          minimumPaymentCents: c.min === null ? null : Number(c.min),
          totalCents: Number(c.total),
          paid: c.paid || Number(c.total) <= 0,
        }))
        .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "")),
      bills: found.map((b) => ({
        id: b.id,
        payee: b.payee,
        card: b.accountId ? (cardName.get(b.accountId) ?? null) : null,
        dueDay: b.dueDay,
        nextDueDate: b.dueDate,
        expectedAmountCents: b.expected,
        lastAmountCents: b.last,
        lastPaidOn: b.lastPaidOn,
        status: b.status,
      })),
    };
  });
}

export type AlertType =
  | "price_increase"
  | "trial_conversion"
  | "unusual_amount"
  | "first_time_merchant"
  | "duplicate_charge"
  | "foreign_charge"
  | "card_fee"
  | "bill_due";

export type AlertView = {
  id: string;
  type: AlertType;
  reason: string;
  subject: string | null;
  occurredOn: string | null;
  status: "open" | "dismissed" | "expected";
  details: Record<string, unknown>;
  /** The linked transactions (date, merchant, amount only). */
  transactions: { id: string; date: string; merchant: string | null; amountCents: number }[];
  more: number;
};

const LINKED = 5;

export async function listAlerts(
  db: AppDb,
  userId: string,
  { status = "open" as "open" | "closed" | "all", limit = 100 } = {},
): Promise<AlertView[]> {
  return withUser(db, userId, async (tx) => {
    const where =
      status === "open"
        ? eq(alerts.status, "open")
        : status === "closed"
          ? sql`${alerts.status} <> 'open'`
          : undefined;
    const rows = await tx
      .select()
      .from(alerts)
      .where(where)
      .orderBy(desc(alerts.occurredOn), desc(alerts.createdAt))
      .limit(limit);
    const ids = [...new Set(rows.flatMap((r) => r.transactionIds.slice(0, LINKED)))];
    const linked = ids.length
      ? await tx
          .select({
            id: transactions.id,
            date: transactions.txnDate,
            merchant: transactions.merchantName,
            amountCents: transactions.amountCents,
          })
          .from(transactions)
          .where(inArray(transactions.id, ids))
      : [];
    const byId = new Map(linked.map((t) => [t.id, t]));
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      reason: r.reason,
      subject: r.subject,
      occurredOn: r.occurredOn,
      status: r.status,
      details: r.details as Record<string, unknown>,
      transactions: r.transactionIds
        .slice(0, LINKED)
        .flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
      more: Math.max(0, r.transactionIds.length - LINKED),
    }));
  });
}

export async function countOpenAlerts(db: AppDb, userId: string): Promise<number> {
  return withUser(db, userId, async (tx) => {
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(alerts)
      .where(eq(alerts.status, "open"));
    return r?.n ?? 0;
  });
}
