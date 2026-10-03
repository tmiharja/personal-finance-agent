import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db/client";
import { categories, proposedActions, rules, transactions } from "@/db/schema";
import { withUser } from "@/db/with-user";
import { logEvent } from "@/server/log";
import { FIXED_KINDS, TxnError } from "@/server/finance/transactions";
import {
  audit,
  canonical,
  expireIfDue,
  lockProposal,
  MAX_ROWS_PER_ACTION,
  PROPOSAL_TTL_MS,
  ProposalError,
  sha256,
} from "./common";

/**
 * "All past and future transactions from this merchant" (PRD CAT-5) becomes a
 * `create_rule` proposal: a rule for future imports plus a recategorisation of
 * the rows listed in the preview. Nothing changes until the user approves, and
 * approval executes exactly the previewed rows (ACT-6).
 */

const payloadSchema = z.object({
  match: z.literal("merchant"),
  pattern: z.string().min(1).max(80),
  categoryId: z.uuid(),
  transactionIds: z.array(z.uuid()).max(MAX_ROWS_PER_ACTION),
});
export type RulePayload = z.output<typeof payloadSchema>;

/** Deterministic, server-built preview (ACT-4). Merchant names and counts only. */
export type RulePreview = {
  kind: "create_rule";
  merchant: string;
  toCategory: string;
  /** Rows that will change, grouped by their current category. */
  changes: { from: string; count: number }[];
  affected: number;
  sample: { txnDate: string; amountCents: number; from: string }[];
};

export async function proposeMerchantRule(
  db: AppDb,
  userId: string,
  transactionId: string,
  categoryId: string,
): Promise<{ proposalId: string; preview: RulePreview; expiresAt: string }> {
  return withUser(db, userId, async (tx) => {
    const [cat] = await tx
      .select()
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.hidden, false)));
    if (!cat || cat.kind === "transfer") throw new ProposalError("invalid_category");
    const [seed] = await tx
      .select({ merchant: transactions.merchantName, kind: transactions.kind })
      .from(transactions)
      .where(eq(transactions.id, transactionId));
    if (!seed?.merchant) throw new TxnError("transaction_not_found");
    if ((FIXED_KINDS as readonly string[]).includes(seed.kind))
      throw new TxnError("not_categorisable");

    const affected = await tx
      .select({
        id: transactions.id,
        version: transactions.version,
        txnDate: transactions.txnDate,
        amountCents: transactions.amountCents,
        from: sql<string>`coalesce(${categories.name}, 'Uncategorised')`,
      })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(
        and(
          sql`lower(${transactions.merchantName}) = lower(${seed.merchant})`,
          inArray(transactions.kind, ["charge", "refund"]),
          sql`${transactions.categoryId} is distinct from ${cat.id}`,
        ),
      )
      .orderBy(sql`${transactions.txnDate} desc`);
    if (affected.length > MAX_ROWS_PER_ACTION) throw new ProposalError("too_many_rows");

    const counts = new Map<string, number>();
    for (const r of affected) counts.set(r.from, (counts.get(r.from) ?? 0) + 1);
    const preview: RulePreview = {
      kind: "create_rule",
      merchant: seed.merchant,
      toCategory: cat.name,
      changes: [...counts]
        .map(([from, count]) => ({ from, count }))
        .sort((a, b) => b.count - a.count),
      affected: affected.length,
      sample: affected
        .slice(0, 5)
        .map((r) => ({ txnDate: r.txnDate, amountCents: r.amountCents, from: r.from })),
    };
    const payload: RulePayload = {
      match: "merchant",
      pattern: seed.merchant,
      categoryId: cat.id,
      transactionIds: affected.map((r) => r.id),
    };
    const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS);
    const [proposal] = await tx
      .insert(proposedActions)
      .values({
        userId,
        type: "create_rule",
        payload,
        payloadHash: sha256(canonical(payload)),
        preview,
        baseVersions: Object.fromEntries(affected.map((r) => [r.id, r.version])),
        proposer: "user",
        expiresAt,
      })
      .returning({ id: proposedActions.id });
    await audit(tx, userId, proposal!.id, "user", "proposed", {
      type: "create_rule",
      rows: affected.length,
    });
    return { proposalId: proposal!.id, preview, expiresAt: expiresAt.toISOString() };
  });
}

export type RuleResult = { ruleId: string; recategorised: number };

export async function approveRuleProposal(
  db: AppDb,
  userId: string,
  proposalId: string,
): Promise<RuleResult> {
  // Expiry and staleness are committed, then reported (a throw would roll them back).
  const outcome = await withUser(
    db,
    userId,
    async (tx): Promise<RuleResult | "expired" | "stale"> => {
      const proposal = await lockProposal(tx, proposalId);
      if (!proposal || proposal.type !== "create_rule")
        throw new ProposalError("proposal_not_found");
      if (proposal.status !== "pending") throw new ProposalError("proposal_not_pending");
      if (await expireIfDue(tx, userId, proposal)) return "expired";
      const parsed = payloadSchema.safeParse(proposal.payload);
      if (!parsed.success || sha256(canonical(proposal.payload)) !== proposal.payloadHash) {
        throw new ProposalError("proposal_not_found");
      }
      const payload = parsed.data;
      const base = proposal.baseVersions as Record<string, number>;

      // ACT-6: the rows must be exactly as previewed (same rows, same versions).
      // Locked first, so a concurrent correction either commits before this check
      // (and the proposal goes stale) or waits until this approval has committed.
      const current = payload.transactionIds.length
        ? await tx
            .select({ id: transactions.id, version: transactions.version })
            .from(transactions)
            .where(inArray(transactions.id, payload.transactionIds))
            .orderBy(transactions.id)
            .for("update")
        : [];
      const [cat] = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.id, payload.categoryId), eq(categories.hidden, false)));
      if (
        !cat ||
        current.length !== payload.transactionIds.length ||
        current.some((r) => base[r.id] !== r.version)
      ) {
        await tx
          .update(proposedActions)
          .set({ status: "stale", decidedAt: new Date(), errorCode: "proposal_stale" })
          .where(eq(proposedActions.id, proposal.id));
        await audit(tx, userId, proposal.id, "system", "failed", { code: "proposal_stale" });
        return "stale";
      }
      await audit(tx, userId, proposal.id, "user", "approved");

      // One rule per merchant: a newer decision replaces an older one.
      const replaced = await tx
        .delete(rules)
        .where(
          and(
            eq(rules.match, "merchant"),
            sql`lower(${rules.pattern}) = lower(${payload.pattern})`,
          ),
        )
        .returning();
      const [rule] = await tx
        .insert(rules)
        .values({
          userId,
          match: "merchant",
          pattern: payload.pattern,
          categoryId: payload.categoryId,
          priority: 100,
          createdViaProposal: proposal.id,
        })
        .returning({ id: rules.id });

      const previous = payload.transactionIds.length
        ? await tx
            .select({
              id: transactions.id,
              categoryId: transactions.categoryId,
              categorySource: transactions.categorySource,
              confidence: transactions.confidence,
            })
            .from(transactions)
            .where(inArray(transactions.id, payload.transactionIds))
        : [];
      if (payload.transactionIds.length) {
        await tx
          .update(transactions)
          .set({
            categoryId: payload.categoryId,
            categorySource: "rule",
            confidence: 1,
            version: sql`${transactions.version} + 1`,
            updatedAt: new Date(),
          })
          .where(inArray(transactions.id, payload.transactionIds));
      }
      const now = new Date();
      await tx
        .update(proposedActions)
        .set({ status: "executed", decidedAt: now, executedAt: now })
        .where(eq(proposedActions.id, proposal.id));
      const result: RuleResult = { ruleId: rule!.id, recategorised: payload.transactionIds.length };
      // The inverse is stored for undo (ACT-9): ids and category ids only.
      await audit(
        tx,
        userId,
        proposal.id,
        "system",
        "executed",
        { recategorised: result.recategorised },
        {
          ruleId: rule!.id,
          replacedRules: replaced.map((r) => ({ categoryId: r.categoryId, priority: r.priority })),
          previous,
        },
      );
      logEvent("rule.created", { recategorised: result.recategorised });
      return result;
    },
  );
  if (outcome === "expired") throw new ProposalError("proposal_expired");
  if (outcome === "stale") throw new ProposalError("proposal_stale");
  return outcome;
}

/** Rejects any pending proposal that isn't an import (imports also discard their preview). */
export async function rejectSimpleProposal(
  db: AppDb,
  userId: string,
  proposalId: string,
): Promise<void> {
  await withUser(db, userId, async (tx) => {
    const proposal = await lockProposal(tx, proposalId);
    if (!proposal || proposal.type === "commit_import")
      throw new ProposalError("proposal_not_found");
    if (proposal.status !== "pending") throw new ProposalError("proposal_not_pending");
    await tx
      .update(proposedActions)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(and(eq(proposedActions.id, proposal.id), ne(proposedActions.status, "executed")));
    await audit(tx, userId, proposal.id, "user", "rejected");
  });
}
