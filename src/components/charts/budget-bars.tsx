import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import type { BudgetLine, BudgetProgress } from "@/server/finance/budgets";

const STATUS: Record<BudgetLine["status"], string> = {
  over: "Over budget",
  at_risk: "Likely to go over",
  on_track: "On track",
  within: "Within budget",
};

/**
 * Budgets (ASK-10): spent against each monthly budget. The status is written
 * out, never shown by colour alone; the bar caps at the budget and an
 * overspend is marked at its end.
 */
export default function BudgetBars({
  progress,
  hrefFor,
}: {
  progress: BudgetProgress;
  hrefFor: (category: string) => string;
}) {
  const partial = progress.daysCovered < progress.daysInMonth;
  return (
    <div>
      {partial && (
        <p className="text-[13px] text-muted">
          Up to {shortDate(progress.asOf)}: {progress.daysCovered} of {progress.daysInMonth} days
          imported. &ldquo;Likely to go over&rdquo; means the pace so far would pass the budget by
          the month&rsquo;s end.
        </p>
      )}
      <ul className="tabular mt-3">
        {progress.lines.map((l) => (
          <li key={l.categoryId}>
            <Link
              href={hrefFor(l.category)}
              className="group grid grid-cols-[minmax(96px,150px)_1fr_auto] items-center gap-3 rounded-md py-1.5 text-[13px] outline-offset-2 hover:bg-accent-soft"
              aria-label={`${l.category}: ${money(l.spentCents)} of ${money(l.budgetCents)}, ${l.percent}%. ${STATUS[l.status]}.`}
            >
              <span className="truncate">{l.category}</span>
              <span className="relative h-3 rounded-r bg-chart-context" aria-hidden>
                <span
                  className={`block h-full rounded-r ${l.status === "over" ? "bg-warn" : "bg-accent"}`}
                  style={{ width: `${Math.min(100, Math.max(1, l.percent))}%` }}
                />
              </span>
              <span className="text-right whitespace-nowrap">
                {money(l.spentCents)} <span className="text-muted">of {money(l.budgetCents)}</span>
                <span
                  className={`block text-[12px] ${l.status === "over" || l.status === "at_risk" ? "text-warn" : "text-muted"}`}
                >
                  {STATUS[l.status]}
                  {l.status === "over" ? ` by ${money(-l.remainingCents)}` : ""}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
