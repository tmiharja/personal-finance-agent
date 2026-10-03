import Link from "next/link";
import { money } from "@/lib/format";

/**
 * Spend by category: one series, so one colour; the category name and value are
 * printed beside each bar (identity never depends on colour). Each row links to
 * the matching transactions. Bars ≤ 24px, 4px rounded end, square at the baseline.
 */
export default function CategoryBars({
  rows,
  hrefFor,
}: {
  rows: { category: string; cents: number; count: number }[];
  hrefFor: (category: string) => string;
}) {
  const max = Math.max(...rows.map((r) => r.cents), 1);
  // Shares are of gross spend (positive categories); a category whose refunds
  // exceed its charges is listed as a net credit, so the rows still add up.
  const total = rows.reduce((s, r) => s + Math.max(0, r.cents), 0);
  return (
    <ul className="tabular">
      {rows.map((r) => {
        const credit = r.cents < 0;
        const share = total && !credit ? Math.round((r.cents / total) * 100) : 0;
        return (
          <li key={r.category}>
            <Link
              href={hrefFor(r.category)}
              className="group grid grid-cols-[minmax(96px,150px)_1fr_auto] items-center gap-3 rounded-md py-1.5 text-[13px] outline-offset-2 hover:bg-accent-soft"
              aria-label={
                credit
                  ? `${r.category}: net credit ${money(r.cents)}, ${r.count} transactions`
                  : `${r.category}: ${money(r.cents)}, ${share}% of spend, ${r.count} transactions`
              }
            >
              <span className="truncate">{r.category}</span>
              <span className="h-3" aria-hidden>
                {!credit && (
                  <span
                    className="block h-full rounded-r bg-accent transition-opacity group-hover:opacity-80"
                    style={{ width: `${Math.max(1, (r.cents / max) * 100)}%` }}
                  />
                )}
              </span>
              <span className="text-right whitespace-nowrap">
                {money(r.cents)}{" "}
                <span className="text-muted">{credit ? "· net refund" : `· ${share}%`}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
