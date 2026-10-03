import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { categories, rules, transactions } from "@/db/schema";
import type { Tx } from "@/db/with-user";
import { FIXED_KINDS } from "@/lib/kinds";
import { MAX_ROWS_PER_ACTION, ProposalError, sha256 } from "../common";
import { register, type ActionPreview, type Versions } from "../engine";
import {
  categoryRefSchema,
  categoryVersion,
  changesOf,
  plural,
  resolveCategory,
  sampleOf,
  selectRows,
  txnVersions,
} from "./shared";

/**
 * Rules (PRD CAT-5): "all past and future transactions from this merchant".
 * Creating one also recategorises the rows listed in the preview; nothing
 * changes until you approve, and approval changes exactly those rows (ACT-6).
 * One rule per merchant: a newer decision replaces an older one.
 */

const ruleRow = z.object({
  id: z.uuid(),
  match: z.enum(["merchant", "descriptor_contains"]),
  pattern: z.string(),
  categoryId: z.uuid(),
  priority: z.number(),
  createdViaProposal: z.uuid().nullable(),
});
type RuleRow = z.output<typeof ruleRow>;

const previousSchema = z.array(
  z.object({
    id: z.uuid(),
    categoryId: z.uuid().nullable(),
    categorySource: z.string().nullable(),
    confidence: z.number().nullable(),
  }),
);

const RULE_COLUMNS = {
  id: rules.id,
  match: rules.match,
  pattern: rules.pattern,
  categoryId: rules.categoryId,
  priority: rules.priority,
  createdViaProposal: rules.createdViaProposal,
};

const merchantRules = (tx: Tx, pattern: string) =>
  tx
    .select(RULE_COLUMNS)
    .from(rules)
    .where(and(eq(rules.match, "merchant"), sql`lower(${rules.pattern}) = lower(${pattern})`))
    .orderBy(rules.id);

/** The merchant's rules as they stand: a rule added or changed meanwhile makes the proposal stale. */
const rulesVersion = async (tx: Tx, pattern: string): Promise<Versions> => ({
  [`rules:${pattern.toLowerCase()}`]:
    (await merchantRules(tx, pattern)).map((r) => `${r.id}=${r.categoryId}`).join(",") || "none",
});

/** Recategorises rows to a rule's category, returning what they were. */
async function applyToRows(tx: Tx, ids: readonly string[], categoryId: string) {
  if (!ids.length) return [];
  const previous = await tx
    .select({
      id: transactions.id,
      categoryId: transactions.categoryId,
      categorySource: transactions.categorySource,
      confidence: transactions.confidence,
    })
    .from(transactions)
    .where(inArray(transactions.id, [...ids]));
  await tx
    .update(transactions)
    .set({
      categoryId,
      categorySource: "rule",
      confidence: 1,
      version: sql`${transactions.version} + 1`,
      updatedAt: new Date(),
    })
    .where(inArray(transactions.id, [...ids]));
  return previous;
}

async function restoreRows(tx: Tx, previous: z.output<typeof previousSchema>) {
  for (const r of previous) {
    await tx
      .update(transactions)
      .set({
        categoryId: r.categoryId,
        categorySource: r.categorySource as (typeof transactions.$inferInsert)["categorySource"],
        confidence: r.confidence,
        version: sql`${transactions.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, r.id));
  }
}

async function restoreRules(tx: Tx, userId: string, replaced: readonly RuleRow[]) {
  if (replaced.length) await tx.insert(rules).values(replaced.map((r) => ({ ...r, userId })));
}

/** A merchant's purchases and refunds that the rule would move, newest first. */
async function rowsForMerchant(tx: Tx, merchant: string, categoryId: string) {
  const rows = await selectRows(tx, { merchant });
  return rows.filter(
    (r) =>
      (r.kind === "charge" || r.kind === "refund") && !r.isTransfer && r.categoryId !== categoryId,
  );
}

const createPayload = z.object({
  match: z.literal("merchant"),
  pattern: z.string().min(1).max(80),
  categoryId: z.uuid(),
  transactionIds: z.array(z.uuid()).max(MAX_ROWS_PER_ACTION),
});

register({
  type: "create_rule",
  /** From a transaction ("all from this merchant") or by merchant name (Ask). */
  input: z.intersection(
    z
      .object({
        transactionId: z.uuid().optional(),
        merchant: z.string().trim().min(1).max(80).optional(),
      })
      .refine((s) => Boolean(s.transactionId) !== Boolean(s.merchant), {
        message: "give transactionId or merchant",
      }),
    categoryRefSchema,
  ),
  payload: createPayload,
  undoable: true,
  ledger: true,
  async prepare(tx, _userId, input) {
    const cat = await resolveCategory(tx, input);
    if (cat.kind === "transfer") throw new ProposalError("invalid_category");
    let merchant: string | null;
    if (input.transactionId) {
      const [seed] = await tx
        .select({ merchant: transactions.merchantName, kind: transactions.kind })
        .from(transactions)
        .where(eq(transactions.id, input.transactionId));
      if (!seed) throw new ProposalError("invalid_reference");
      if ((FIXED_KINDS as readonly string[]).includes(seed.kind))
        throw new ProposalError("not_categorisable");
      merchant = seed.merchant;
    } else {
      // The merchant as stored, so the rule matches what imports write.
      const [m] = await tx
        .select({ merchant: transactions.merchantName })
        .from(transactions)
        .where(sql`lower(${transactions.merchantName}) = lower(${input.merchant})`)
        .limit(1);
      merchant = m?.merchant ?? null;
    }
    if (!merchant) throw new ProposalError("invalid_reference");
    const change = await rowsForMerchant(tx, merchant, cat.id);
    const existing = await merchantRules(tx, merchant);
    const preview: ActionPreview = {
      title: `Always categorise ${merchant} as ${cat.name}`,
      lines: [
        change.length
          ? `Recategorises ${plural(change.length, "past transaction")} and every future import.`
          : "No past transactions change; applies to every future import.",
        ...(existing.length ? ["Replaces the rule you already have for this merchant."] : []),
      ],
      changes: changesOf(change, cat.name),
      sample: sampleOf(change),
      // The rule itself counts, even when no past row changes.
      affected: change.length + 1,
    };
    return {
      payload: {
        match: "merchant",
        pattern: merchant,
        categoryId: cat.id,
        transactionIds: change.map((r) => r.id),
      },
      preview,
    };
  },
  async versions(tx, p, lock) {
    return {
      ...(await txnVersions(tx, p.transactionIds, lock)),
      ...(await categoryVersion(tx, p.categoryId)),
      ...(await rulesVersion(tx, p.pattern)),
      // The merchant's rows the rule would move, as previewed: a row imported
      // meanwhile makes the proposal stale rather than being silently left out.
      [`moves:${p.pattern.toLowerCase()}`]: sha256(
        (await rowsForMerchant(tx, p.pattern, p.categoryId))
          .map((r) => r.id)
          .sort()
          .join(","),
      ),
    };
  },
  async execute(tx, userId, p, proposalId) {
    const replaced = await tx
      .delete(rules)
      .where(and(eq(rules.match, "merchant"), sql`lower(${rules.pattern}) = lower(${p.pattern})`))
      .returning(RULE_COLUMNS);
    const [rule] = await tx
      .insert(rules)
      .values({
        userId,
        match: "merchant",
        pattern: p.pattern,
        categoryId: p.categoryId,
        priority: 100,
        createdViaProposal: proposalId,
      })
      .returning({ id: rules.id });
    const previous = await applyToRows(tx, p.transactionIds, p.categoryId);
    return {
      result: { ruleId: rule!.id, recategorised: p.transactionIds.length },
      inverse: { ruleId: rule!.id, replaced, previous },
    };
  },
  async undo(tx, userId, _p, inverse) {
    const inv = z
      .object({ ruleId: z.uuid(), replaced: z.array(ruleRow), previous: previousSchema })
      .parse(inverse);
    await tx.delete(rules).where(eq(rules.id, inv.ruleId));
    await restoreRules(tx, userId, inv.replaced);
    await restoreRows(tx, inv.previous);
  },
});

async function loadRule(tx: Tx, ruleId: string) {
  const [r] = await tx
    .select({ ...RULE_COLUMNS, category: categories.name })
    .from(rules)
    .innerJoin(categories, eq(categories.id, rules.categoryId))
    .where(eq(rules.id, ruleId));
  if (!r) throw new ProposalError("invalid_reference");
  return r;
}

const ruleVersion = async (tx: Tx, ruleId: string, lock: boolean): Promise<Versions> => {
  const q = tx.select({ c: rules.categoryId }).from(rules).where(eq(rules.id, ruleId));
  const [r] = lock ? await q.for("update") : await q;
  return { [`rule:${ruleId}`]: r?.c ?? "missing" };
};

const updatePayload = z.object({
  ruleId: z.uuid(),
  categoryId: z.uuid(),
  transactionIds: z.array(z.uuid()).max(MAX_ROWS_PER_ACTION),
});

register({
  type: "update_rule",
  input: z.intersection(z.object({ ruleId: z.uuid() }), categoryRefSchema),
  payload: updatePayload,
  undoable: true,
  ledger: true,
  async prepare(tx, _userId, input) {
    const rule = await loadRule(tx, input.ruleId);
    const cat = await resolveCategory(tx, input);
    if (cat.kind === "transfer" || cat.id === rule.categoryId)
      throw new ProposalError("invalid_category");
    // Rows the rule categorised move with it; rows you set by hand stay as they are.
    const moved =
      rule.match === "merchant"
        ? (await rowsForMerchant(tx, rule.pattern, cat.id)).filter(
            (r) => r.categoryId === rule.categoryId && r.source === "rule",
          )
        : [];
    return {
      payload: { ruleId: rule.id, categoryId: cat.id, transactionIds: moved.map((r) => r.id) },
      preview: {
        title: `Change the ${rule.pattern} rule to ${cat.name}`,
        lines: [
          `It was ${rule.category}.`,
          moved.length
            ? `Moves ${plural(moved.length, "transaction")} the rule categorised.`
            : "No past transactions change.",
        ],
        changes: changesOf(moved, cat.name),
        sample: sampleOf(moved),
        affected: moved.length + 1,
      },
    };
  },
  async versions(tx, p, lock) {
    return {
      ...(await ruleVersion(tx, p.ruleId, lock)),
      ...(await txnVersions(tx, p.transactionIds, lock)),
      ...(await categoryVersion(tx, p.categoryId)),
    };
  },
  async execute(tx, _userId, p) {
    const [before] = await tx
      .select({ categoryId: rules.categoryId })
      .from(rules)
      .where(eq(rules.id, p.ruleId));
    await tx.update(rules).set({ categoryId: p.categoryId }).where(eq(rules.id, p.ruleId));
    const previous = await applyToRows(tx, p.transactionIds, p.categoryId);
    return {
      result: { recategorised: p.transactionIds.length },
      inverse: { categoryId: before!.categoryId, previous },
    };
  },
  async undo(tx, _userId, p, inverse) {
    const inv = z.object({ categoryId: z.uuid(), previous: previousSchema }).parse(inverse);
    await tx.update(rules).set({ categoryId: inv.categoryId }).where(eq(rules.id, p.ruleId));
    await restoreRows(tx, inv.previous);
  },
});

register({
  type: "delete_rule",
  input: z.object({ ruleId: z.uuid() }),
  payload: z.object({ ruleId: z.uuid(), pattern: z.string() }),
  undoable: true,
  ledger: false,
  async prepare(tx, _userId, input) {
    const rule = await loadRule(tx, input.ruleId);
    return {
      payload: { ruleId: rule.id, pattern: rule.pattern },
      preview: {
        title: `Delete the rule ${rule.pattern} → ${rule.category}`,
        lines: [
          "Transactions it already categorised keep their category.",
          "Future imports from this merchant are categorised automatically again.",
        ],
        affected: 1,
      },
    };
  },
  versions: async (tx, p, lock) => ({
    ...(await ruleVersion(tx, p.ruleId, lock)),
    ...(await rulesVersion(tx, p.pattern)),
  }),
  async execute(tx, _userId, p) {
    const [gone] = await tx.delete(rules).where(eq(rules.id, p.ruleId)).returning(RULE_COLUMNS);
    return { result: { deleted: 1 }, inverse: { rule: gone } };
  },
  async undo(tx, userId, _p, inverse) {
    const { rule } = z.object({ rule: ruleRow }).parse(inverse);
    await restoreRules(tx, userId, [rule]);
  },
});
