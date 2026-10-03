import Link from "next/link";
import { money, shortDate, titleCase } from "@/lib/format";
import type { WeeklyDigest } from "@/server/finance/digest";
import { filterHref } from "@/server/finance/transactions";

const ALERT: Record<string, string> = {
  price_increase: "price rise",
  trial_conversion: "trial now paid",
  unusual_amount: "unusual amount",
  first_time_merchant: "new merchant",
  duplicate_charge: "possible duplicate",
  foreign_charge: "foreign currency",
  card_fee: "card fee",
  bill_due: "payment due",
};

/** DET-10: last week at a glance (in-app; nothing is emailed). */
export default function WeeklyDigestCard({ digest: d }: { digest: WeeklyDigest }) {
  const range = `${shortDate(d.week.from)} – ${shortDate(d.week.to)}`;
  return (
    <section aria-labelledby="digest" className="mt-12">
      <div className="flex items-baseline justify-between">
        <h2 id="digest" className="text-[17px] font-semibold">
          Last week
        </h2>
        <span className="text-[13px] text-muted">{range}</span>
      </div>
      <div className="mt-3 grid gap-4 rounded-lg border border-rule px-4 py-4 text-[15px] md:grid-cols-3">
        <div>
          <span className="block text-[13px] text-muted">Spent</span>
          {d.imported || d.partial ? (
            <>
              <Link
                href={filterHref({ from: d.week.from, to: d.week.to, spend: "1" })}
                className="tabular font-medium hover:underline"
              >
                {money(d.spentCents)}
              </Link>
              <span className="block text-[13px] text-muted">
                {d.changePct === null
                  ? `${d.count} transactions`
                  : `${d.changePct > 0 ? "▲" : d.changePct < 0 ? "▼" : "•"} ${Math.abs(d.changePct)}% vs the week before (${money(d.previousCents)})`}
              </span>
              {d.topCategories.length > 0 && (
                <span className="block text-[13px] text-muted">
                  Most on {d.topCategories.map((c) => `${c.category} ${money(c.cents)}`).join(", ")}
                </span>
              )}
              {d.partial && (
                <span className="block text-[12px] text-warn">
                  Not every card or account is imported for this week yet.
                </span>
              )}
            </>
          ) : (
            <span className="block text-[13px] text-muted">
              Not imported yet{d.dataTo ? `: your statements run to ${shortDate(d.dataTo)}` : ""}.
            </span>
          )}
        </div>
        <div>
          <span className="block text-[13px] text-muted">New alerts</span>
          {d.alerts.length === 0 ? (
            <span className="font-medium">None</span>
          ) : (
            <Link href="/app/alerts" className="hover:underline">
              <span className="font-medium">{d.alerts.length} open</span>
              <span className="block text-[13px] text-muted">
                {d.alerts
                  .slice(0, 3)
                  .map(
                    (a) =>
                      `${ALERT[a.type] ?? "alert"}${a.subject ? `, ${titleCase(a.subject)}` : ""}`,
                  )
                  .join(" · ")}
              </span>
            </Link>
          )}
        </div>
        <div>
          <span className="block text-[13px] text-muted">Due in the next 7 days</span>
          {d.dueSoon.length === 0 ? (
            <span className="font-medium">Nothing</span>
          ) : (
            <Link href="/app/bills" className="hover:underline">
              {d.dueSoon.slice(0, 3).map((b) => (
                <span key={`${b.what}${b.due}`} className="block text-[13px]">
                  <span className="tabular">{shortDate(b.due)}</span> · {titleCase(b.what)}
                  {b.cents !== null && <> · {money(b.cents)}</>}
                </span>
              ))}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
