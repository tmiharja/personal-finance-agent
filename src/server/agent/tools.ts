import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { sqlRows } from "@/db/rows";
import type { Tx } from "@/db/with-user";
import {
  monthlySpend,
  spendByCategory,
  spendTotals,
  topMerchants,
  type Range,
  type Scope,
  type SpendTotals,
} from "@/server/finance/spend";
import { filterHref } from "@/server/finance/transactions";
import type { BetaTool } from "@/server/llm/types";
import { maskForLlm } from "@/server/pii/firewall";
import { PER_MONTH, type Cadence } from "@/server/detect/recurring";
import { budgetProgress } from "@/server/finance/budgets";
import { cancellationDraft, duplicateDisputeDraft, feeWaiverDraft, type Draft } from "@/lib/drafts";
import { resolvePeriod } from "./period";
import {
  PROPOSE_DESCRIPTIONS,
  PROPOSE_SCHEMAS,
  runPropose,
  type ProposeTool,
  type ProposedCard,
} from "./proposals";

/**
 * Ask's read-only tools (PRD ASK-2, architecture ⑮). Each runs parameterised
 * SQL inside the caller's withUser() transaction, so RLS scopes it to the
 * signed-in user; the user id is never a tool argument. Results are small,
 * masked, and carry amounts as SGD strings the answer must quote verbatim.
 */

export type Figure =
  | { kind: "bars"; title: string; points: { label: string; cents: number }[] }
  | { kind: "columns"; title: string; points: { label: string; cents: number }[] };

/** A link under the answer; `label` replaces "View N transactions" for other screens. */
export type View = { href: string; count: number; label?: string };

export type ToolOutcome = {
  /** JSON sent back to the model. */
  result: Record<string, unknown>;
  view?: View;
  figure?: Figure;
  excluded?: SpendTotals["excluded"];
  /** A change Ask proposed: shown as an approval card, never applied by Ask. */
  proposal?: ProposedCard;
  /** A draft to copy (ACT-2), shown under the answer. */
  draft?: Draft;
};

export type ToolContext = {
  tx: Tx;
  /** From the server-side session, never a tool argument. */
  userId: string;
  today: string;
  coverage: Range | null;
  categories: readonly string[];
};

const sgd = (cents: number) => (cents / 100).toFixed(2);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const nullable = <T extends z.ZodType>(t: T) => t.nullable();

const SCHEMAS = {
  resolve_period: z.object({
    expression: z
      .string()
      .min(1)
      .max(60)
      .describe(
        'The period in the user\'s words, e.g. "Q3", "last month", "March 2026", "2026-01-01 to 2026-03-31".',
      ),
  }),
  spend_summary: z.object({
    from: date,
    to: date,
    category: nullable(z.string().max(60)).describe(
      "Exact category name from list_categories, or null for all.",
    ),
    merchant: nullable(z.string().max(80)).describe("Merchant name, or null for all."),
  }),
  spend_by_category: z.object({ from: date, to: date }),
  compare_periods: z.object({
    first_from: date,
    first_to: date,
    second_from: date,
    second_to: date,
    category: nullable(z.string().max(60)),
    merchant: nullable(z.string().max(80)),
  }),
  top_merchants: z.object({
    from: date,
    to: date,
    category: nullable(z.string().max(60)),
    limit: nullable(z.number().int().min(1).max(10)),
  }),
  monthly_spend: z.object({
    from: date,
    to: date,
    category: nullable(z.string().max(60)),
    merchant: nullable(z.string().max(80)),
  }),
  find_transactions: z.object({
    from: nullable(date),
    to: nullable(date),
    category: nullable(z.string().max(60)),
    merchant: nullable(z.string().max(80)),
    sort: z.enum(["newest", "largest"]),
    limit: nullable(z.number().int().min(1).max(20)),
  }),
  list_categories: z.object({}),
  get_subscriptions: z.object({}),
  get_bills: z.object({}),
  get_alerts: z.object({ include_closed: z.boolean() }),
  get_budgets: z.object({
    month: nullable(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "use YYYY-MM")).describe(
      "The month, or null for the latest month with data.",
    ),
  }),
  get_draft: z.object({
    kind: z.enum(["fee_waiver", "duplicate_dispute", "cancellation"]),
    alert_id: nullable(z.uuid()).describe(
      "For fee_waiver and duplicate_dispute: the id from get_alerts.",
    ),
    merchant: nullable(z.string().max(80)).describe(
      "For cancellation: the subscription's merchant.",
    ),
  }),
  ...PROPOSE_SCHEMAS,
} as const;

export type ToolName = keyof typeof SCHEMAS;

const DESCRIPTIONS: Record<ToolName, string> = {
  resolve_period:
    "Turns the user's words for a time period into exact dates and a label. Call it before any other tool whenever the question mentions a period; use the returned from/to and quote the label in your answer.",
  spend_summary:
    "Total spend for a period across cards and bank accounts (charges, fees and debit purchases, refunds netted; card payments, transfers between the person's own accounts and cashback excluded), optionally for one category or merchant. Returns the amount, the transaction count and what was excluded; without a category or merchant it also returns income (salary, interest and other money in) for the period.",
  spend_by_category: "Spend per category for a period, largest first.",
  compare_periods:
    "Spend in two periods side by side, with the difference and percentage change already calculated. Use this for any comparison instead of calculating.",
  top_merchants: "The merchants with the most spend in a period, optionally within one category.",
  monthly_spend:
    "Spend per calendar month across a range, optionally for one category or merchant.",
  find_transactions:
    "Individual transactions (date, merchant, amount, category), newest or largest first, at most 20, with the total number that match.",
  list_categories: "The user's category names, to use exactly in other tools.",
  get_subscriptions:
    "Detected subscriptions: merchant, cadence, price, monthly equivalent, status (active, overdue, possibly cancelled), next expected date and any price change, plus the monthly total.",
  get_bills:
    "Card payments due (each card's latest statement: due date, total, minimum, paid or not) and detected recurring bills (payee, usual day, usual amount, next date).",
  get_alerts:
    "Alerts raised by the detectors (price rises, trials that became paid, unusual or duplicate charges, foreign spending, card fees, payments due), each with its id and reason. Open ones only unless include_closed is true.",
  get_budgets:
    'Monthly budgets against spend for a month: per category the budget, spent so far, remaining, percent used, the projected month-end spend at the current pace and a status (over, at_risk, on_track, within), plus totals and how many days of the month the data covers. Use it for "am I on track?".',
  get_draft:
    "A draft the person can copy and send themselves (never sent by the app): a fee waiver request for a card_fee alert, a dispute message for a duplicate_charge alert, or steps to cancel a subscription. The app shows the draft under your answer; don't repeat it, just say it's there.",
  ...PROPOSE_DESCRIPTIONS,
};

/** Tool definitions in a fixed order (a changing tools list breaks prompt caching). */
export const TOOLS: BetaTool[] = (Object.keys(SCHEMAS) as ToolName[]).map((name) => {
  const raw = z.toJSONSchema(SCHEMAS[name]) as Record<string, unknown>;
  delete raw.$schema;
  // Strict mode accepts a subset of JSON Schema; the SDK moves the rest (lengths,
  // ranges, patterns) into descriptions. zod still enforces them on the way in.
  const schema = transformJSONSchema(raw);
  return {
    name,
    description: DESCRIPTIONS[name],
    // Strict: arguments always match the schema. Inputs are tiny (dates and
    // names), so eager input streaming would buy nothing; zod re-validates below.
    strict: true,
    input_schema: { ...schema, type: "object" } as BetaTool["input_schema"],
  };
});

class ToolInputError extends Error {}

async function resolveScope(
  ctx: ToolContext,
  category: string | null | undefined,
  merchant: string | null | undefined,
): Promise<{ scope: Scope } | { error: Record<string, unknown> }> {
  const scope: Scope = {};
  if (category) {
    const match = ctx.categories.find((c) => c.toLowerCase() === category.toLowerCase());
    if (!match) return { error: { error: "unknown_category", categories: ctx.categories } };
    scope.category = match;
  }
  if (merchant) {
    const exact = sqlRows<{ m: string }>(
      await ctx.tx.execute(
        sql`select distinct merchant_name as m from transactions where lower(merchant_name) = lower(${merchant}) limit 1`,
      ),
    );
    if (exact[0]) scope.merchant = exact[0].m;
    else {
      const like = sqlRows<{ m: string }>(
        await ctx.tx.execute(
          sql`select distinct merchant_name as m from transactions where merchant_name ilike ${`%${merchant.replace(/[%_\\]/g, "\\$&")}%`} order by 1 limit 6`,
        ),
      );
      if (like.length === 1) scope.merchant = like[0]!.m;
      else {
        return {
          error: {
            error: like.length ? "ambiguous_merchant" : "unknown_merchant",
            did_you_mean: like.map((l) => maskForLlm(l.m)),
          },
        };
      }
    }
  }
  return { scope };
}

function viewFor(range: Range, scope: Scope, count: number): View {
  return {
    href: filterHref({
      from: range.from,
      to: range.to,
      category: scope.category,
      merchant: scope.merchant,
      spend: "1",
    }),
    count,
  };
}

const excludedNote = (e: SpendTotals["excluded"]) => ({
  card_payments_excluded: e.cardPayments,
  cashback_credits_excluded: e.cashback,
  own_account_transfers_excluded: e.transfers,
});

function checkRange(from: string, to: string): Range {
  if (from > to) throw new ToolInputError("from is after to");
  return { from, to };
}

export async function runTool(
  ctx: ToolContext,
  name: string,
  input: unknown,
): Promise<ToolOutcome> {
  if (!(name in SCHEMAS)) return { result: { error: "unknown_tool", tools: Object.keys(SCHEMAS) } };
  const parsed = SCHEMAS[name as ToolName].safeParse(input);
  if (!parsed.success) {
    return {
      result: {
        error: "invalid_input",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
    };
  }
  try {
    return await run(ctx, name as ToolName, parsed.data as never);
  } catch (e) {
    if (e instanceof ToolInputError)
      return { result: { error: "invalid_input", issues: [e.message] } };
    throw e;
  }
}

async function run(
  ctx: ToolContext,
  name: ToolName,
  a: Record<string, never>,
): Promise<ToolOutcome> {
  const args = a as Record<string, unknown>;
  switch (name) {
    case "resolve_period": {
      const p = resolvePeriod(String(args.expression), ctx.today, ctx.coverage);
      return { result: { ...p, today: ctx.today, data_covers: ctx.coverage } };
    }
    case "list_categories":
      return { result: { categories: ctx.categories } };
    case "get_subscriptions": {
      const rows = sqlRows<{
        merchant: string;
        cadence: Cadence;
        cents: string;
        status: string;
        next: string | null;
        last: string | null;
        prev: string | null;
        changed: string | null;
        charges: number;
      }>(
        await ctx.tx.execute(sql`
          select merchant_name as merchant, cadence, amount_cents::text as cents, status, next_expected_date::text as next,
                 last_charge_date::text as last, previous_amount_cents::text as prev, price_changed_on::text as changed, charges
          from subscriptions where not ignored`),
      );
      const items = rows
        .map((r) => ({ ...r, monthly: Math.round(Number(r.cents) * PER_MONTH[r.cadence]) }))
        .sort((a, b) => b.monthly - a.monthly);
      const running = items.filter((r) => r.status === "active" || r.status === "overdue");
      return {
        result: {
          monthly_total_sgd: sgd(running.reduce((s, r) => s + r.monthly, 0)),
          running: running.length,
          subscriptions: items.map((r) => ({
            merchant: maskForLlm(r.merchant),
            cadence: r.cadence,
            price_sgd: sgd(Number(r.cents)),
            monthly_equivalent_sgd: sgd(r.monthly),
            status: r.status,
            next_expected: r.next,
            last_charged: r.last,
            charges: r.charges,
            ...(r.prev && r.changed
              ? { previous_price_sgd: sgd(Number(r.prev)), price_changed_on: r.changed }
              : {}),
          })),
        },
        view: { href: "/app/subscriptions", count: items.length, label: "Open Subscriptions" },
        figure: {
          kind: "bars",
          title: "Monthly cost",
          points: items
            .slice(0, 8)
            .map((r) => ({ label: maskForLlm(r.merchant), cents: r.monthly })),
        },
      };
    }
    case "get_bills": {
      const cards = sqlRows<{
        card: string;
        statement: string;
        due: string | null;
        total: string;
        min: string | null;
        paid: boolean;
      }>(
        await ctx.tx.execute(sql`
          select distinct on (s.account_id)
                 case when a.ordinal > 1 then a.product_name || ' (' || a.ordinal || ')' else a.product_name end as card,
                 s.statement_date::text as statement, s.due_date::text as due, s.total_cents::text as total,
                 s.minimum_payment_cents::text as min,
                 exists (select 1 from transactions t
                         where (t.account_id = s.account_id or t.transfer_account_id = s.account_id)
                         and t.kind = 'card_payment' and t.txn_date > s.statement_date) as paid
          from statements s join accounts a on a.id = s.account_id
          where a.kind = 'card'
          order by s.account_id, s.statement_date desc`),
      );
      const recurring = sqlRows<{
        payee: string;
        day: number | null;
        expected: string | null;
        next: string | null;
        last: string | null;
      }>(
        await ctx.tx.execute(sql`
          select payee, due_day as day, expected_amount_cents::text as expected, due_date::text as next, last_paid_on::text as last
          from bills order by due_date`),
      );
      return {
        result: {
          today: ctx.today,
          card_payments: cards.map((c) => ({
            card: c.card,
            statement_date: c.statement,
            due_date: c.due,
            statement_total_sgd: sgd(Number(c.total)),
            minimum_sgd: c.min === null ? null : sgd(Number(c.min)),
            paid: c.paid || Number(c.total) <= 0,
          })),
          recurring_bills: recurring.map((b) => ({
            payee: maskForLlm(b.payee),
            usual_day_of_month: b.day,
            usual_amount_sgd: b.expected === null ? null : sgd(Number(b.expected)),
            next_expected: b.next,
            last_paid: b.last,
          })),
        },
        view: { href: "/app/bills", count: cards.length + recurring.length, label: "Open Bills" },
      };
    }
    case "get_alerts": {
      const rows = sqlRows<{
        id: string;
        type: string;
        reason: string;
        status: string;
        on: string | null;
      }>(
        await ctx.tx.execute(sql`
          select id, type, reason, status, occurred_on::text as on from alerts
          ${args.include_closed ? sql`` : sql`where status = 'open'`}
          order by occurred_on desc nulls last, created_at desc limit 30`),
      );
      return {
        result: {
          alerts: rows.map((r) => ({
            id: r.id,
            type: r.type,
            reason: maskForLlm(r.reason),
            status: r.status,
            date: r.on,
          })),
          shown: rows.length,
        },
        view: { href: "/app/alerts", count: rows.length, label: "Open Alerts" },
      };
    }
    case "spend_summary": {
      const range = checkRange(String(args.from), String(args.to));
      const s = await resolveScope(
        ctx,
        args.category as string | null,
        args.merchant as string | null,
      );
      if ("error" in s) return { result: s.error };
      const t = await spendTotals(ctx.tx, range, s.scope);
      return {
        result: {
          from: range.from,
          to: range.to,
          category: s.scope.category ?? "all",
          merchant: s.scope.merchant ? maskForLlm(s.scope.merchant) : "all",
          spent_sgd: sgd(t.spentCents),
          refunds_netted_sgd: sgd(-t.refundsCents),
          transactions: t.count,
          ...(s.scope.category || s.scope.merchant
            ? {}
            : { income_sgd: sgd(t.incomeCents), income_transactions: t.incomeCount }),
          ...excludedNote(t.excluded),
        },
        view: viewFor(range, s.scope, t.count),
        excluded: t.excluded,
      };
    }
    case "spend_by_category": {
      const range = checkRange(String(args.from), String(args.to));
      const [rows, t] = await Promise.all([
        spendByCategory(ctx.tx, range),
        spendTotals(ctx.tx, range),
      ]);
      return {
        result: {
          from: range.from,
          to: range.to,
          total_spent_sgd: sgd(t.spentCents),
          categories: rows.map((r) => ({
            category: r.category,
            spent_sgd: sgd(r.cents),
            transactions: r.count,
          })),
          ...excludedNote(t.excluded),
        },
        view: viewFor(range, {}, t.count),
        figure: {
          kind: "bars",
          title: "Spend by category",
          points: rows.slice(0, 8).map((r) => ({ label: r.category, cents: r.cents })),
        },
        excluded: t.excluded,
      };
    }
    case "compare_periods": {
      const first = checkRange(String(args.first_from), String(args.first_to));
      const second = checkRange(String(args.second_from), String(args.second_to));
      const s = await resolveScope(
        ctx,
        args.category as string | null,
        args.merchant as string | null,
      );
      if ("error" in s) return { result: s.error };
      const [x, y] = await Promise.all([
        spendTotals(ctx.tx, first, s.scope),
        spendTotals(ctx.tx, second, s.scope),
      ]);
      const diff = y.spentCents - x.spentCents;
      return {
        result: {
          category: s.scope.category ?? "all",
          merchant: s.scope.merchant ? maskForLlm(s.scope.merchant) : "all",
          first: {
            from: first.from,
            to: first.to,
            spent_sgd: sgd(x.spentCents),
            transactions: x.count,
          },
          second: {
            from: second.from,
            to: second.to,
            spent_sgd: sgd(y.spentCents),
            transactions: y.count,
          },
          second_minus_first_sgd: sgd(diff),
          difference_sgd: sgd(Math.abs(diff)),
          direction: diff > 0 ? "up" : diff < 0 ? "down" : "same",
          change_pct:
            x.spentCents > 0 ? (Math.round((diff / x.spentCents) * 1000) / 10).toFixed(1) : null,
        },
        view: viewFor(
          {
            from: first.from < second.from ? first.from : second.from,
            to: first.to > second.to ? first.to : second.to,
          },
          s.scope,
          x.count + y.count,
        ),
        figure: {
          kind: "columns",
          title: s.scope.category ?? s.scope.merchant ?? "Spend",
          points: [
            { label: `${first.from} – ${first.to}`, cents: x.spentCents },
            { label: `${second.from} – ${second.to}`, cents: y.spentCents },
          ],
        },
        excluded: {
          cardPayments: x.excluded.cardPayments + y.excluded.cardPayments,
          cashback: x.excluded.cashback + y.excluded.cashback,
          transfers: x.excluded.transfers + y.excluded.transfers,
        },
      };
    }
    case "top_merchants": {
      const range = checkRange(String(args.from), String(args.to));
      const s = await resolveScope(ctx, args.category as string | null, null);
      if ("error" in s) return { result: s.error };
      const [rows, all] = await Promise.all([
        topMerchants(ctx.tx, range, s.scope, Number(args.limit ?? 5)),
        spendTotals(ctx.tx, range, s.scope),
      ]);
      return {
        result: {
          from: range.from,
          to: range.to,
          category: s.scope.category ?? "all",
          merchants: rows.map((r, i) => ({
            rank: i + 1,
            merchant: maskForLlm(r.merchant),
            spent_sgd: sgd(r.cents),
            transactions: r.count,
          })),
        },
        view: viewFor(
          range,
          s.scope,
          // The link opens every merchant in the period, so it counts all their rows.
          all.count,
        ),
        figure: {
          kind: "bars",
          title: "Top merchants",
          points: rows.map((r) => ({ label: maskForLlm(r.merchant), cents: r.cents })),
        },
      };
    }
    case "monthly_spend": {
      const range = checkRange(String(args.from), String(args.to));
      const s = await resolveScope(
        ctx,
        args.category as string | null,
        args.merchant as string | null,
      );
      if ("error" in s) return { result: s.error };
      const months = (await monthlySpend(ctx.tx, range, s.scope)).slice(-24);
      const t = await spendTotals(ctx.tx, range, s.scope);
      return {
        result: {
          category: s.scope.category ?? "all",
          merchant: s.scope.merchant ? maskForLlm(s.scope.merchant) : "all",
          months: months.map((m) => ({ month: m.month, spent_sgd: sgd(m.cents) })),
          total_spent_sgd: sgd(t.spentCents),
        },
        view: viewFor(range, s.scope, t.count),
        figure: {
          kind: "columns",
          title: s.scope.category ?? s.scope.merchant ?? "Spend per month",
          points: months.map((m) => ({ label: m.month, cents: m.cents })),
        },
        excluded: t.excluded,
      };
    }
    case "find_transactions": {
      const from = (args.from as string | null) ?? ctx.coverage?.from ?? "1970-01-01";
      const to = (args.to as string | null) ?? ctx.coverage?.to ?? ctx.today;
      const range = checkRange(from, to);
      const s = await resolveScope(
        ctx,
        args.category as string | null,
        args.merchant as string | null,
      );
      if ("error" in s) return { result: s.error };
      const limit = Number(args.limit ?? 10);
      const where = sql`t.txn_date between ${range.from} and ${range.to} and t.kind in ('charge', 'fee', 'refund') and not t.is_transfer
        ${s.scope.category ? sql`and coalesce(c.name, 'Uncategorised') = ${s.scope.category}` : sql``}
        ${s.scope.merchant ? sql`and lower(t.merchant_name) = lower(${s.scope.merchant})` : sql``}`;
      const order =
        args.sort === "largest"
          ? sql`t.amount_cents desc, t.txn_date desc`
          : sql`t.txn_date desc, t.amount_cents desc`;
      const rows = sqlRows<{
        d: string;
        m: string | null;
        cents: string;
        c: string;
        kind: string;
        fx: string | null;
        ccy: string | null;
      }>(
        await ctx.tx.execute(sql`
          select t.txn_date::text as d, t.merchant_name as m, t.amount_cents::text as cents,
                 coalesce(c.name, 'Uncategorised') as c, t.kind, t.fx_amount::text as fx, t.fx_currency as ccy
          from transactions t left join categories c on c.id = t.category_id
          where ${where} order by ${order} limit ${limit}`),
      );
      const [count] = sqlRows<{ n: number }>(
        await ctx.tx.execute(
          sql`select count(*)::int as n from transactions t left join categories c on c.id = t.category_id where ${where}`,
        ),
      );
      return {
        result: {
          from: range.from,
          to: range.to,
          total_matching: count!.n,
          shown: rows.length,
          transactions: rows.map((r) => ({
            date: r.d,
            merchant: maskForLlm(r.m ?? "Unknown"),
            amount_sgd: sgd(Number(r.cents)),
            category: r.c,
            ...(r.kind === "refund" ? { refund: true } : {}),
            ...(r.fx ? { foreign_amount: `${r.ccy ?? ""} ${r.fx}`.trim() } : {}),
          })),
        },
        view: viewFor(range, s.scope, count!.n),
      };
    }
    case "get_budgets": {
      const latest = ctx.coverage?.to.slice(0, 7);
      const month = (args.month as string | null) ?? latest;
      if (!month || !ctx.coverage) return { result: { error: "no_data" } };
      const p = await budgetProgress(ctx.tx, month, ctx.coverage.to);
      if (!p) return { result: { budgets: [], note: "No budgets are set." } };
      return {
        result: {
          month,
          data_up_to: p.asOf,
          days_covered: p.daysCovered,
          days_in_month: p.daysInMonth,
          budgets: p.lines.map((l) => ({
            category: l.category,
            budget_sgd: sgd(l.budgetCents),
            spent_sgd: sgd(l.spentCents),
            remaining_sgd: sgd(l.remainingCents),
            percent_used: l.percent,
            projected_month_end_sgd: l.projectedCents === null ? null : sgd(l.projectedCents),
            status: l.status,
          })),
          total: {
            budget_sgd: sgd(p.total.budgetCents),
            spent_sgd: sgd(p.total.spentCents),
            remaining_sgd: sgd(p.total.remainingCents),
            percent_used: p.total.percent,
          },
        },
        view: { href: `/app?month=${month}`, count: p.lines.length, label: "Open Overview" },
        figure: {
          kind: "bars",
          title: "Spent of budget",
          points: p.lines.map((l) => ({ label: l.category, cents: l.spentCents })),
        },
      };
    }
    case "get_draft": {
      const draft = await draftFor(ctx, args);
      if ("error" in draft) return { result: draft };
      return {
        result: { title: draft.title, shown_below_answer: true },
        draft,
      };
    }
    default:
      return propose(ctx, name, args);
  }
}

/** Merchants and categories resolved like the read tools, then proposed (never applied). */
async function propose(
  ctx: ToolContext,
  name: ProposeTool,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  if (name !== "propose_bill" && name !== "propose_alert_decision") {
    const resolved = await resolveScope(
      ctx,
      typeof args.category === "string" ? args.category : null,
      typeof args.merchant === "string" ? args.merchant : null,
    );
    if ("error" in resolved) return { result: resolved.error };
    args = { ...args, ...resolved.scope };
  }
  if (typeof args.from === "string" && typeof args.to === "string") checkRange(args.from, args.to);
  const out = await runPropose(ctx.tx, ctx.userId, name, args);
  return out.proposal
    ? {
        result: out.result,
        proposal: out.proposal,
        view: { href: "/app/activity", count: 1, label: "Open Activity" },
      }
    : { result: out.result };
}

/** ACT-2 drafts from the alert or subscription the model names (RLS-scoped lookups). */
async function draftFor(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<Draft | { error: string }> {
  if (args.kind === "cancellation") {
    const [s] = sqlRows<{ merchant: string; cadence: string; cents: string; next: string | null }>(
      await ctx.tx.execute(sql`
        select merchant_name as merchant, cadence, amount_cents::text as cents, next_expected_date::text as next
        from subscriptions where lower(merchant_name) = lower(${String(args.merchant ?? "")}) limit 1`),
    );
    if (!s) return { error: "unknown_subscription" };
    return cancellationDraft({
      merchant: s.merchant,
      cadence: s.cadence,
      amountCents: Number(s.cents),
      nextExpectedDate: s.next,
    });
  }
  if (typeof args.alert_id !== "string") return { error: "alert_id_required" };
  const [a] = sqlRows<{
    type: string;
    subject: string | null;
    on: string | null;
    details: Record<string, unknown>;
    ids: string[];
  }>(
    await ctx.tx.execute(sql`
      select type, subject, occurred_on::text as on, details, transaction_ids as ids
      from alerts where id = ${args.alert_id}`),
  );
  if (!a) return { error: "unknown_alert" };
  if (args.kind === "fee_waiver" && a.type === "card_fee" && a.subject && a.on) {
    return feeWaiverDraft({
      card: a.subject,
      feeCents: Number(a.details.feeCents ?? 0),
      gstCents: Number(a.details.gstCents ?? 0),
      kind: String(a.details.kind ?? ""),
      date: a.on,
    });
  }
  if (args.kind === "duplicate_dispute" && a.type === "duplicate_charge" && a.subject) {
    const rows = sqlRows<{ date: string; cents: string }>(
      await ctx.tx.execute(sql`
        select txn_date::text as date, amount_cents::text as cents from transactions
        where id = any(${a.ids}::uuid[]) order by txn_date`),
    );
    if (!rows.length) return { error: "unknown_alert" };
    return duplicateDisputeDraft({
      merchant: a.subject,
      amountCents: Number(rows[0]!.cents),
      dates: rows.map((r) => r.date),
    });
  }
  return { error: "no_draft_for_this_alert" };
}
