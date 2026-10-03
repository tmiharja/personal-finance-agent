import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { categories, proposedActions, transactions } from "@/db/schema";
import type { Tx } from "@/db/with-user";
import { MAX_ROWS_PER_ACTION, ProposalError } from "../common";
import type { ActionPreview, ActionType, Versions } from "../engine";

/**
 * Building blocks shared by the action definitions. Every lookup runs inside
 * the caller's withUser() transaction: RLS makes anything that isn't yours
 * look like it doesn't exist, so a foreign id is just `invalid_reference`.
 */

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Which transactions an action is about: ids (from a screen) or a merchant
 * and optional dates (from Ask, which never sees ids).
 */
export const selectionSchema = z
  .object({
    transactionIds: z.array(z.uuid()).min(1).max(MAX_ROWS_PER_ACTION).optional(),
    merchant: z.string().trim().min(1).max(80).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((s) => Boolean(s.transactionIds) !== Boolean(s.merchant), {
    message: "give transactionIds or merchant",
  });
export type Selection = z.output<typeof selectionSchema>;

/** A category by id (screens) or exact name (Ask). */
export const categoryRefSchema = z
  .object({
    categoryId: z.uuid().optional(),
    category: z.string().trim().min(1).max(60).optional(),
  })
  .refine((c) => Boolean(c.categoryId) !== Boolean(c.category), {
    message: "give categoryId or category",
  });

export type CategoryRow = { id: string; name: string; kind: string };

export async function resolveCategory(
  tx: Tx,
  ref: { categoryId?: string; category?: string },
): Promise<CategoryRow> {
  const [cat] = await tx
    .select({ id: categories.id, name: categories.name, kind: categories.kind })
    .from(categories)
    .where(
      and(
        ref.categoryId
          ? eq(categories.id, ref.categoryId)
          : sql`lower(${categories.name}) = lower(${ref.category ?? ""})`,
        eq(categories.hidden, false),
      ),
    );
  if (!cat) throw new ProposalError("invalid_category");
  return cat;
}

export type SelectedRow = {
  id: string;
  version: number;
  kind: string;
  merchant: string | null;
  txnDate: string;
  amountCents: number;
  categoryId: string | null;
  category: string;
  source: string | null;
  isTransfer: boolean;
  paired: boolean;
};

/** The rows a selection names, newest first. Ids that aren't yours are an error, not skipped. */
export async function selectRows(tx: Tx, s: Selection): Promise<SelectedRow[]> {
  const where = [];
  if (s.transactionIds) where.push(inArray(transactions.id, s.transactionIds));
  if (s.merchant) where.push(sql`lower(${transactions.merchantName}) = lower(${s.merchant})`);
  if (s.from) where.push(sql`${transactions.txnDate} >= ${s.from}`);
  if (s.to) where.push(sql`${transactions.txnDate} <= ${s.to}`);
  const rows = await tx
    .select({
      id: transactions.id,
      version: transactions.version,
      kind: transactions.kind,
      merchant: transactions.merchantName,
      txnDate: transactions.txnDate,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      category: sql<string>`coalesce(${categories.name}, 'Uncategorised')`,
      source: transactions.categorySource,
      isTransfer: transactions.isTransfer,
      paired: sql<boolean>`${transactions.transferPairId} is not null`,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(...where))
    .orderBy(sql`${transactions.txnDate} desc`, transactions.id)
    .limit(MAX_ROWS_PER_ACTION + 1);
  if (rows.length > MAX_ROWS_PER_ACTION) throw new ProposalError("too_many_rows");
  if (s.transactionIds && rows.length !== new Set(s.transactionIds).size)
    throw new ProposalError("invalid_reference");
  return rows;
}

/** Versions of these transactions ("txn:<id>" → version). A deleted row drops out: stale. */
export async function txnVersions(
  tx: Tx,
  ids: readonly string[],
  lock: boolean,
): Promise<Versions> {
  if (!ids.length) return {};
  const q = tx
    .select({ id: transactions.id, version: transactions.version })
    .from(transactions)
    .where(inArray(transactions.id, [...ids]))
    .orderBy(transactions.id);
  const rows = lock ? await q.for("update") : await q;
  return Object.fromEntries(rows.map((r) => [`txn:${r.id}`, r.version]));
}

/** A category that must still exist and be visible: "cat:<id>" → its name. */
export async function categoryVersion(tx: Tx, id: string): Promise<Versions> {
  const [c] = await tx
    .select({ name: categories.name, hidden: categories.hidden })
    .from(categories)
    .where(eq(categories.id, id));
  return { [`cat:${id}`]: c && !c.hidden ? c.name : "missing" };
}

/** "From → to" counts, largest first. */
export function changesOf(rows: readonly { category: string }[], to: string) {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  return [...counts]
    .map(([from, count]) => ({ from, to, count }))
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
}

export const sampleOf = (rows: readonly SelectedRow[]): ActionPreview["sample"] =>
  rows.slice(0, 5).map((r) => ({
    txnDate: r.txnDate,
    merchant: r.merchant ?? "Unknown merchant",
    amountCents: r.amountCents,
  }));

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-SG")} ${n === 1 ? one : many}`;

export const sgd = (cents: number) =>
  `S$${(cents / 100).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Where a selection came from, for the preview title. */
export const scopeText = (s: Selection) =>
  s.merchant
    ? `${s.merchant}${s.from || s.to ? ` (${s.from ?? "start"} to ${s.to ?? "now"})` : ""}`
    : null;

/**
 * The latest executed, not undone, decision on a target: part of its version,
 * so a value that changes and changes back (S$100 → S$200 → S$100) still
 * counts as changed, and an older undo can't overwrite the newer decision.
 */
export async function lastDecision(
  tx: Tx,
  types: readonly ActionType[],
  target: SQL,
): Promise<string> {
  const [d] = await tx
    .select({ id: proposedActions.id })
    .from(proposedActions)
    .where(
      and(
        inArray(proposedActions.type, [...types]),
        eq(proposedActions.status, "executed"),
        sql`${proposedActions.undoneAt} is null`,
        target,
      ),
    )
    .orderBy(sql`${proposedActions.executedAt} desc`, sql`${proposedActions.id} desc`)
    .limit(1);
  return d?.id ?? "none";
}

/** `payload->>key = value`, for lastDecision. */
export const payloadIs = (key: string, value: string) =>
  sql`${proposedActions.payload}->>${key} = ${value}`;

/** The payload's array `key` contains `value`, for lastDecision. */
export const payloadHas = (key: string, value: string) =>
  sql`${proposedActions.payload}->${key} @> ${JSON.stringify([value])}::jsonb`;
