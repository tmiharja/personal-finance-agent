import type { Metadata } from "next";
import Link from "next/link";
import CategoryBars from "@/components/charts/category-bars";
import MonthTrend from "@/components/charts/month-trend";
import Stat from "@/components/charts/stat";
import EmptyState from "@/components/empty-state";
import PageTitle from "@/components/app/page-title";
import { getDb } from "@/db/client";
import { money } from "@/lib/format";
import { requireUser } from "@/server/auth/session";
import { getMonthOverview } from "@/server/finance/overview";
import { addMonths, monthRange } from "@/server/finance/spend";
import { countToReview, filterHref } from "@/server/finance/transactions";

export const metadata: Metadata = { title: "Overview" };

const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00+08:00`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Singapore",
  });
const shortMonth = (month: string) =>
  new Date(`${month}-01T00:00:00+08:00`).toLocaleDateString("en-GB", {
    month: "short",
    timeZone: "Asia/Singapore",
  });

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string | string[] }>;
}) {
  const user = await requireUser();
  const requested = (await searchParams).month;
  const db = getDb();
  const [o, toReview] = await Promise.all([
    getMonthOverview(db, user.id, Array.isArray(requested) ? requested[0] : requested),
    countToReview(db, user.id),
  ]);

  if (!o) {
    return (
      <>
        <PageTitle title="Overview">
          Your month at a glance, once there&rsquo;s something to show.
        </PageTitle>
        <EmptyState
          title="No statements yet"
          action={{ href: "/app/import", label: "Import a statement" }}
          note="DBS and UOB credit-card PDFs are supported first. Files are read in memory and discarded."
        >
          Import a few months of statements and this page will show spend by category and how it
          changes month to month.
        </EmptyState>
      </>
    );
  }

  const range = monthRange(o.month);
  const prev = addMonths(o.month, -1);
  const next = addMonths(o.month, 1);
  const change =
    o.previous && o.previous.spentCents > 0
      ? Math.round(((o.totals.spentCents - o.previous.spentCents) / o.previous.spentCents) * 100)
      : null;

  return (
    <>
      <PageTitle title="Overview">
        Card spending for the month: charges and fees, with refunds netted. Card payments and
        cashback are shown separately.
      </PageTitle>

      <nav aria-label="Month" className="mb-6 flex items-baseline justify-between text-[15px]">
        {prev >= o.span.first ? (
          <Link href={`/app?month=${prev}`} className="link text-[13px]">
            ← {shortMonth(prev)}
          </Link>
        ) : (
          <span />
        )}
        <h2 className="text-[20px] font-semibold tracking-tight">{monthName(o.month)}</h2>
        {next <= o.span.last ? (
          <Link href={`/app?month=${next}`} className="link text-[13px]">
            {shortMonth(next)} →
          </Link>
        ) : (
          <span />
        )}
      </nav>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
        <Stat
          label="Spent"
          value={money(o.totals.spentCents)}
          note={
            change === null ? (
              `${o.totals.count} transactions`
            ) : (
              <span className={change > 0 ? "text-warn" : undefined}>
                {change > 0 ? "▲" : change < 0 ? "▼" : "•"} {Math.abs(change)}% vs{" "}
                {shortMonth(prev)}
              </span>
            )
          }
        />
        <Stat label="Refunds" value={money(-o.totals.refundsCents)} note="already netted" />
        <Stat
          label="Cashback"
          value={money(-o.totals.cashbackCents)}
          note={`${o.totals.excluded.cashback} credits`}
        />
        <Stat
          label="Card payments"
          value={money(-o.totals.cardPaymentsCents)}
          note="not counted as spend"
        />
      </dl>

      <section aria-labelledby="by-category" className="mt-12">
        <div className="flex items-baseline justify-between">
          <h2 id="by-category" className="text-[17px] font-semibold">
            Spend by category
          </h2>
          {toReview > 0 && (
            <Link href={filterHref({ review: "1" })} className="text-[13px] text-warn">
              {toReview} to review
            </Link>
          )}
        </div>
        {o.byCategory.length === 0 ? (
          <p className="mt-4 text-[15px] text-muted">No spending this month.</p>
        ) : (
          <div className="mt-3">
            <CategoryBars
              rows={o.byCategory}
              hrefFor={(category) =>
                filterHref({ category, from: range.from, to: range.to, spend: "1" })
              }
            />
          </div>
        )}
      </section>

      <section aria-labelledby="trend" className="mt-12">
        <h2 id="trend" className="text-[17px] font-semibold">
          Last 12 months
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          Spend per month. Select a month to see it here.
        </p>
        <div className="mt-6">
          <MonthTrend
            months={o.trend}
            selected={o.month}
            hrefFor={(month) => `/app?month=${month}`}
          />
        </div>
      </section>
    </>
  );
}
