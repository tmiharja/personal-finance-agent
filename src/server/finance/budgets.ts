import { eq } from "drizzle-orm";
import { budgets, categories } from "@/db/schema";
import type { Tx } from "@/db/with-user";
import { monthRange, spendByCategory } from "./spend";

/**
 * Budgets (PRD ASK-10): a monthly amount per spending category, measured with
 * the same spend definition as Overview and Ask. Every figure, including the
 * pace, is computed here so Ask quotes it rather than doing arithmetic.
 *
 * Statements arrive monthly, so "so far" means up to the last date your data
 * covers in that month, not today: a month whose statements aren't all in yet
 * is judged on the days it covers.
 */

export type BudgetStatus = "over" | "at_risk" | "on_track" | "within";

export type BudgetLine = {
  categoryId: string;
  category: string;
  budgetCents: number;
  spentCents: number;
  /** Negative when over. */
  remainingCents: number;
  /** Spent as a whole percentage of the budget. */
  percent: number;
  /** Spend at this pace by the month's end (null once the month is fully covered). */
  projectedCents: number | null;
  status: BudgetStatus;
};

export type BudgetProgress = {
  month: string;
  /** The last date counted, and how much of the month that is. */
  asOf: string;
  daysCovered: number;
  daysInMonth: number;
  lines: BudgetLine[];
  total: { budgetCents: number; spentCents: number; remainingCents: number; percent: number };
};

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** Progress for `month` (YYYY-MM), counting spend up to `coveredTo` (the data's last date). */
export async function budgetProgress(
  tx: Tx,
  month: string,
  coveredTo: string,
): Promise<BudgetProgress | null> {
  const set = await tx
    .select({
      categoryId: budgets.categoryId,
      category: categories.name,
      cents: budgets.monthlyAmountCents,
    })
    .from(budgets)
    .innerJoin(categories, eq(categories.id, budgets.categoryId))
    .orderBy(categories.sort, categories.name);
  if (!set.length) return null;
  const range = monthRange(month);
  const asOf = coveredTo < range.to ? coveredTo : range.to;
  const daysInMonth = Number(range.to.slice(8));
  const daysCovered = asOf < range.from ? 0 : Number(asOf.slice(8));
  const spent = new Map(
    (await spendByCategory(tx, { from: range.from, to: asOf })).map((c) => [c.category, c.cents]),
  );
  const complete = daysCovered >= daysInMonth;
  const lines: BudgetLine[] = set.map((b) => {
    const spentCents = Math.max(0, spent.get(b.category) ?? 0);
    const projectedCents =
      complete || daysCovered === 0 ? null : Math.round((spentCents / daysCovered) * daysInMonth);
    const status: BudgetStatus =
      spentCents > b.cents
        ? "over"
        : complete
          ? "within"
          : projectedCents !== null && projectedCents > b.cents
            ? "at_risk"
            : "on_track";
    return {
      categoryId: b.categoryId,
      category: b.category,
      budgetCents: b.cents,
      spentCents,
      remainingCents: b.cents - spentCents,
      percent: pct(spentCents, b.cents),
      projectedCents,
      status,
    };
  });
  const budgetCents = lines.reduce((s, l) => s + l.budgetCents, 0);
  const spentCents = lines.reduce((s, l) => s + l.spentCents, 0);
  return {
    month,
    asOf,
    daysCovered,
    daysInMonth,
    lines,
    total: {
      budgetCents,
      spentCents,
      remainingCents: budgetCents - spentCents,
      percent: pct(spentCents, budgetCents),
    },
  };
}
