import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { categories, tags, transactions, transactionTags } from "@/db/schema";
import type { Tx } from "@/db/with-user";
import { FIXED_KINDS, TRANSFER_MERCHANTS } from "@/lib/kinds";
import { ProposalError } from "../common";
import { register, type ActionPreview } from "../engine";
import {
  categoryRefSchema,
  categoryVersion,
  changesOf,
  plural,
  resolveCategory,
  sampleOf,
  scopeText,
  selectionSchema,
  selectRows,
  txnVersions,
  type SelectedRow,
} from "./shared";

/**
 * Transaction actions: recategorise, mark as transfer, tag. Each previews the
 * exact rows it will change, and executes only those rows at the versions
 * previewed (ACT-6). The inverse holds ids and the previous category only.
 */

const isFixed = (r: SelectedRow) => (FIXED_KINDS as readonly string[]).includes(r.kind);

const categoryPayload = z.object({
  categoryId: z.uuid(),
  transfer: z.boolean(),
  transactionIds: z.array(z.uuid()).min(1),
});
type CategoryPayload = z.output<typeof categoryPayload>;

const previousSchema = z.array(
  z.object({
    id: z.uuid(),
    categoryId: z.uuid().nullable(),
    categorySource: z.string().nullable(),
    confidence: z.number().nullable(),
    isTransfer: z.boolean(),
  }),
);

async function setCategory(tx: Tx, p: CategoryPayload) {
  const previous = await tx
    .select({
      id: transactions.id,
      categoryId: transactions.categoryId,
      categorySource: transactions.categorySource,
      confidence: transactions.confidence,
      isTransfer: transactions.isTransfer,
    })
    .from(transactions)
    .where(inArray(transactions.id, p.transactionIds));
  await tx
    .update(transactions)
    .set({
      categoryId: p.categoryId,
      categorySource: "user",
      confidence: null,
      isTransfer: p.transfer,
      version: sql`${transactions.version} + 1`,
      updatedAt: new Date(),
    })
    .where(inArray(transactions.id, p.transactionIds));
  return { result: { changed: p.transactionIds.length }, inverse: { previous } };
}

async function restoreCategories(tx: Tx, inverse: unknown) {
  const { previous } = z.object({ previous: previousSchema }).parse(inverse);
  for (const r of previous) {
    await tx
      .update(transactions)
      .set({
        categoryId: r.categoryId,
        categorySource: r.categorySource as (typeof transactions.$inferInsert)["categorySource"],
        confidence: r.confidence,
        isTransfer: r.isTransfer,
        version: sql`${transactions.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, r.id));
  }
}

const categoryVersions = async (tx: Tx, p: CategoryPayload, lock: boolean) => ({
  ...(await txnVersions(tx, p.transactionIds, lock)),
  ...(await categoryVersion(tx, p.categoryId)),
});

/** Rows a recategorisation would change; system rows and paired transfers never change. */
function editable(rows: readonly SelectedRow[], categoryId: string, explicit: boolean) {
  const blocked = rows.filter((r) => isFixed(r) || r.paired);
  // Naming a fixed row by id is an error; a merchant-wide change just leaves them out.
  if (explicit && blocked.length) throw new ProposalError("not_categorisable");
  // Choosing a row's current category confirms it (a low-confidence guess becomes yours).
  return rows.filter(
    (r) =>
      !isFixed(r) &&
      !r.paired &&
      (r.categoryId !== categoryId || (explicit && r.source !== "user")),
  );
}

register({
  type: "recategorise_transactions",
  input: z.intersection(selectionSchema, categoryRefSchema),
  payload: categoryPayload,
  undoable: true,
  ledger: true,
  async prepare(tx, _userId, input) {
    const cat = await resolveCategory(tx, input);
    const rows = await selectRows(tx, input);
    const change = editable(rows, cat.id, Boolean(input.transactionIds));
    // "Transfers" confirms a PayNow/FAST transfer as your own money moving (IMP-10);
    // it isn't a category for purchases.
    const transfer = cat.kind === "transfer";
    if (transfer && change.some((r) => !TRANSFER_MERCHANTS.has(r.merchant ?? "")))
      throw new ProposalError("invalid_category");
    const scope = scopeText(input);
    const preview: ActionPreview = {
      title: `Recategorise ${plural(change.length, "transaction")} to ${cat.name}`,
      lines: [
        scope ? `Transactions from ${scope}.` : "The transactions you chose.",
        "Future imports are not affected: create a rule for that.",
      ],
      changes: changesOf(change, cat.name),
      sample: sampleOf(change),
      affected: change.length,
    };
    return {
      payload: { categoryId: cat.id, transfer, transactionIds: change.map((r) => r.id) },
      preview,
    };
  },
  versions: categoryVersions,
  execute: (tx, _userId, p) => setCategory(tx, p),
  undo: (tx, _userId, _p, inverse) => restoreCategories(tx, inverse),
});

register({
  type: "mark_transfer",
  input: selectionSchema,
  payload: categoryPayload,
  undoable: true,
  ledger: true,
  async prepare(tx, _userId, input) {
    const [cat] = await tx
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(and(eq(categories.kind, "transfer"), eq(categories.hidden, false)))
      .limit(1);
    if (!cat) throw new ProposalError("invalid_category");
    const rows = await selectRows(tx, input);
    // Only PayNow/FAST/funds transfers can be your own money moving.
    const notTransfer = rows.some((r) => !TRANSFER_MERCHANTS.has(r.merchant ?? ""));
    if (notTransfer && input.transactionIds) throw new ProposalError("not_categorisable");
    const change = editable(
      rows.filter((r) => TRANSFER_MERCHANTS.has(r.merchant ?? "")),
      cat.id,
      Boolean(input.transactionIds),
    );
    const preview: ActionPreview = {
      title: `Mark ${plural(change.length, "transfer")} as between your own accounts`,
      lines: [
        "They leave spending and income, like card payments do.",
        "Undo puts them back in their categories.",
      ],
      changes: changesOf(change, cat.name),
      sample: sampleOf(change),
      affected: change.length,
    };
    return {
      payload: { categoryId: cat.id, transfer: true, transactionIds: change.map((r) => r.id) },
      preview,
    };
  },
  versions: categoryVersions,
  execute: (tx, _userId, p) => setCategory(tx, p),
  undo: (tx, _userId, _p, inverse) => restoreCategories(tx, inverse),
});

const tagName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N} &'_-]+$/u, "letters, numbers, spaces and & ' _ - only");

const tagPayload = z.object({ tag: tagName, transactionIds: z.array(z.uuid()).min(1) });

register({
  type: "tag_transactions",
  input: z.intersection(selectionSchema, z.object({ tag: tagName })),
  payload: tagPayload,
  undoable: true,
  ledger: false,
  async prepare(tx, _userId, input) {
    const rows = await selectRows(tx, input);
    const [existing] = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(sql`lower(${tags.name}) = lower(${input.tag})`);
    const tagged = existing
      ? new Set(
          (
            await tx
              .select({ id: transactionTags.transactionId })
              .from(transactionTags)
              .where(eq(transactionTags.tagId, existing.id))
          ).map((r) => r.id),
        )
      : new Set<string>();
    const change = rows.filter((r) => !tagged.has(r.id));
    const preview: ActionPreview = {
      title: `Tag ${plural(change.length, "transaction")} "${input.tag}"`,
      lines: [existing ? "Adds to an existing tag." : "Creates a new tag."],
      sample: sampleOf(change),
      affected: change.length,
    };
    return { payload: { tag: input.tag, transactionIds: change.map((r) => r.id) }, preview };
  },
  async versions(tx, p, lock) {
    const [t] = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(sql`lower(${tags.name}) = lower(${p.tag})`);
    const links = t
      ? await tx
          .select({ id: transactionTags.transactionId })
          .from(transactionTags)
          .where(
            and(
              eq(transactionTags.tagId, t.id),
              inArray(transactionTags.transactionId, p.transactionIds),
            ),
          )
      : [];
    return {
      ...(await txnVersions(tx, p.transactionIds, lock)),
      "tag:links": links.length,
    };
  },
  async execute(tx, userId, p) {
    const [found] = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(sql`lower(${tags.name}) = lower(${p.tag})`);
    const tagId =
      found?.id ??
      (await tx.insert(tags).values({ userId, name: p.tag }).returning({ id: tags.id }))[0]!.id;
    await tx
      .insert(transactionTags)
      .values(p.transactionIds.map((transactionId) => ({ userId, transactionId, tagId })))
      .onConflictDoNothing();
    return {
      result: { tagged: p.transactionIds.length },
      inverse: { tagId, created: !found },
    };
  },
  async undo(tx, _userId, p, inverse) {
    const { tagId, created } = z.object({ tagId: z.uuid(), created: z.boolean() }).parse(inverse);
    await tx
      .delete(transactionTags)
      .where(
        and(
          eq(transactionTags.tagId, tagId),
          inArray(transactionTags.transactionId, p.transactionIds),
        ),
      );
    if (created) {
      const [left] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transactionTags)
        .where(eq(transactionTags.tagId, tagId));
      if (!left?.n) await tx.delete(tags).where(eq(tags.id, tagId));
    }
  },
});
