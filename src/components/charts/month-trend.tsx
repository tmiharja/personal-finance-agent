import Link from "next/link";
import { money, monthLabel } from "@/lib/format";

const label = (month: string, style: "short" | "long") =>
  monthLabel(month, style === "short" ? "narrow" : "medium");

/**
 * Twelve months of spend as columns. The selected month is the accent; the rest
 * are the muted context step (validated ≥ 3:1). Only the selected value is
 * printed; every column shows its value on hover and keyboard focus (and is a
 * link to that month), and the same numbers are in a table for screen readers.
 */
export default function MonthTrend({
  months,
  selected,
  hrefFor,
}: {
  months: { month: string; cents: number }[];
  selected: string;
  hrefFor: (month: string) => string;
}) {
  const max = Math.max(...months.map((m) => m.cents), 1);
  return (
    <figure>
      <div className="flex h-36 items-end gap-[2px] border-b border-rule">
        {months.map((m) => {
          const isSel = m.month === selected;
          const h = Math.max(0, (m.cents / max) * 100);
          return (
            <Link
              key={m.month}
              href={hrefFor(m.month)}
              aria-label={`${label(m.month, "long")}: ${money(m.cents)}`}
              aria-current={isSel ? "date" : undefined}
              className="group relative flex h-full flex-1 items-end justify-center rounded-sm outline-offset-2"
            >
              {isSel && (
                <span
                  aria-hidden
                  className="tabular absolute text-[11px] whitespace-nowrap"
                  style={{ bottom: `calc(${h}% + 4px)` }}
                >
                  {money(m.cents)}
                </span>
              )}
              <span
                aria-hidden
                className={`block w-full max-w-6 rounded-t transition-opacity group-hover:opacity-80 ${
                  isSel ? "bg-accent" : "bg-chart-context"
                }`}
                style={{ height: `${h}%` }}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute bottom-full z-10 mb-1 hidden rounded-md border border-rule bg-background px-2 py-1 text-[12px] whitespace-nowrap group-hover:block group-focus-visible:block"
              >
                <strong className="tabular font-medium">{money(m.cents)}</strong>{" "}
                <span className="text-muted">{label(m.month, "long")}</span>
              </span>
            </Link>
          );
        })}
      </div>
      <div className="mt-1 flex gap-[2px] text-[11px] text-muted" aria-hidden>
        {months.map((m) => (
          <span
            key={m.month}
            className={`flex-1 text-center ${m.month === selected ? "text-foreground" : ""}`}
          >
            {label(m.month, "short")}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>Card spend by month</caption>
        <tbody>
          {months.map((m) => (
            <tr key={m.month}>
              <th scope="row">{label(m.month, "long")}</th>
              <td>{money(m.cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
