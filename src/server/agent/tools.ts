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
import { resolvePeriod } from "./period";

/**
 * Ask's read-only tools (PRD ASK-2, architecture ⑮). Each runs parameterised
 * SQL inside the caller's withUser() transaction, so RLS scopes it to the
 * signed-in user; the user id is never a tool argument. Results are small,
 * masked, and carry amounts as SGD strings the answer must quote verbatim.
 */

export type Figure =
  | { kind: "bars"; title: string; points: { label: string; cents: number }[] }
  | { kind: "columns"; title: string; points: { label: string; cents: number }[] };

export type View = { href: string; count: number };

export type ToolOutcome = {
  /** JSON sent back to the model. */
  result: Record<string, unknown>;
  view?: View;
  figure?: Figure;
  excluded?: SpendTotals["excluded"];
};

export type ToolContext = {
  tx: Tx;
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
} as const;

export type ToolName = keyof typeof SCHEMAS;

const DESCRIPTIONS: Record<ToolName, string> = {
  resolve_period:
    "Turns the user's words for a time period into exact dates and a label. Call it before any other tool whenever the question mentions a period; use the returned from/to and quote the label in your answer.",
  spend_summary:
    "Total card spend for a period (charges and fees, refunds netted; card payments and cashback excluded), optionally for one category or merchant. Returns the amount, the transaction count and what was excluded.",
  spend_by_category: "Spend per category for a period, largest first.",
  compare_periods:
    "Spend in two periods side by side, with the difference and percentage change already calculated. Use this for any comparison instead of calculating.",
  top_merchants: "The merchants with the most spend in a period, optionally within one category.",
  monthly_spend:
    "Spend per calendar month across a range, optionally for one category or merchant.",
  find_transactions:
    "Individual transactions (date, merchant, amount, category), newest or largest first, at most 20, with the total number that match.",
  list_categories: "The user's category names, to use exactly in other tools.",
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
      const where = sql`t.txn_date between ${range.from} and ${range.to} and t.kind in ('charge', 'fee', 'refund')
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
  }
}
