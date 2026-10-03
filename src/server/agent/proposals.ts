import { sql } from "drizzle-orm";
import { z } from "zod";
import { sqlRows } from "@/db/rows";
import { proposeIn, type ActionPreview, type ActionType } from "@/server/actions";
import { ProposalError } from "@/server/actions/common";
import { maskForLlm } from "@/server/pii/firewall";

/**
 * Ask's propose-only tools (PRD ACT-10, architecture ⑮). Each one creates a
 * pending proposal through the action engine, as proposer "agent": the
 * preview is built by the server, and nothing changes until the person
 * approves the card shown under the answer. There is no tool that approves.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const merchant = z.string().min(1).max(80);
const category = z.string().min(1).max(60);
const sgdAmount = z.number().min(0).max(1_000_000);

export const PROPOSE_SCHEMAS = {
  propose_recategorise: z.object({
    merchant,
    category: category.describe("Exact category name from list_categories."),
    from: date.nullable(),
    to: date.nullable(),
  }),
  propose_rule: z.object({ merchant, category }),
  propose_mark_transfer: z.object({
    merchant: merchant.describe('A transfer merchant, e.g. "PayNow transfer" or "FAST transfer".'),
    from: date.nullable(),
    to: date.nullable(),
  }),
  propose_tag: z.object({
    merchant,
    tag: z.string().min(1).max(40),
    from: date.nullable(),
    to: date.nullable(),
  }),
  propose_budget: z.object({
    category,
    monthly_amount_sgd: sgdAmount.nullable().describe("null removes the budget."),
  }),
  propose_alert_decision: z.object({
    alert_id: z.uuid().describe("The id from get_alerts."),
    decision: z.enum(["dismiss", "expected"]),
  }),
  propose_ignore_subscription: z.object({ merchant, ignored: z.boolean() }),
  propose_bill: z.object({
    payee: z.string().min(2).max(60),
    due_day: z.number().int().min(1).max(31),
    usual_amount_sgd: sgdAmount.nullable(),
  }),
} as const;

export type ProposeTool = keyof typeof PROPOSE_SCHEMAS;

const AFTER = " Nothing changes until the person approves the card shown under your answer.";

export const PROPOSE_DESCRIPTIONS: Record<ProposeTool, string> = {
  propose_recategorise:
    "Suggests moving a merchant's transactions (optionally within dates) to another category, for this past data only." +
    AFTER,
  propose_rule:
    "Suggests a rule: always categorise this merchant as the category, including past transactions and future imports." +
    AFTER,
  propose_mark_transfer:
    "Suggests marking PayNow/FAST transfers as money moving between the person's own accounts, so they leave spending and income." +
    AFTER,
  propose_tag: "Suggests tagging a merchant's transactions (optionally within dates)." + AFTER,
  propose_budget:
    "Suggests a monthly budget for a spending category, or removing it (null)." + AFTER,
  propose_alert_decision:
    "Suggests dismissing an alert, or marking it as expected, by its id from get_alerts." + AFTER,
  propose_ignore_subscription:
    "Suggests ignoring a detected subscription (it leaves the monthly total), or showing it again." +
    AFTER,
  propose_bill: "Suggests adding a recurring bill the person told you about." + AFTER,
};

const cents = (sgd: number | null) => (sgd === null ? null : Math.round(sgd * 100));
const range = (a: { from: string | null; to: string | null }) => ({
  ...(a.from ? { from: a.from } : {}),
  ...(a.to ? { to: a.to } : {}),
});

/** Maps a tool call to an allowed action and its input. Merchants are already resolved. */
async function toAction(
  tx: Parameters<typeof proposeIn>[0],
  name: ProposeTool,
  a: Record<string, unknown>,
): Promise<{ type: ActionType; input: unknown } | { error: string }> {
  switch (name) {
    case "propose_recategorise":
      return {
        type: "recategorise_transactions",
        input: { merchant: a.merchant, category: a.category, ...range(a as never) },
      };
    case "propose_rule":
      return { type: "create_rule", input: { merchant: a.merchant, category: a.category } };
    case "propose_mark_transfer":
      return { type: "mark_transfer", input: { merchant: a.merchant, ...range(a as never) } };
    case "propose_tag":
      return {
        type: "tag_transactions",
        input: { merchant: a.merchant, tag: a.tag, ...range(a as never) },
      };
    case "propose_budget":
      return {
        type: "set_budget",
        input: {
          category: a.category,
          monthlyAmountCents: cents(a.monthly_amount_sgd as number | null),
        },
      };
    case "propose_alert_decision":
      return {
        type: a.decision === "dismiss" ? "dismiss_alert" : "mark_alert_expected",
        input: { alertIds: [a.alert_id] },
      };
    case "propose_ignore_subscription": {
      const [s] = sqlRows<{ id: string }>(
        await tx.execute(
          sql`select id from subscriptions where lower(merchant_name) = lower(${String(a.merchant)}) order by updated_at desc limit 1`,
        ),
      );
      if (!s) return { error: "unknown_subscription" };
      return {
        type: "set_subscription_status",
        input: { subscriptionId: s.id, ignored: a.ignored },
      };
    }
    case "propose_bill":
      return {
        type: "add_bill",
        input: {
          payee: a.payee,
          dueDay: a.due_day,
          expectedAmountCents: cents(a.usual_amount_sgd as number | null),
        },
      };
  }
}

export type ProposedCard = { id: string; preview: ActionPreview };

/** Creates the proposal, or returns the refusal code for the model to explain. */
export async function runPropose(
  tx: Parameters<typeof proposeIn>[0],
  userId: string,
  name: ProposeTool,
  args: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; proposal?: ProposedCard }> {
  const action = await toAction(tx, name, args);
  if ("error" in action) return { result: { error: action.error } };
  try {
    // A refused proposal must not roll back the reads around it: a savepoint.
    const p = await tx.transaction((sp) =>
      proposeIn(sp as typeof tx, userId, "agent", action.type, action.input),
    );
    return {
      result: {
        proposed: true,
        // Masked like every other tool result: merchant names come from statements.
        title: maskForLlm(p.preview.title),
        details: p.preview.lines.map((l) => maskForLlm(l)),
        affected: p.preview.affected,
        note: "Shown to the person as a card to approve or discard. Tell them to check it; don't say it's done.",
      },
      proposal: { id: p.proposalId, preview: p.preview },
    };
  } catch (e) {
    if (e instanceof ProposalError) return { result: { error: e.code } };
    throw e;
  }
}
