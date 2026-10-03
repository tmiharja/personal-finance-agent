import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/empty-state";
import PageTitle from "@/components/app/page-title";
import PatchButton from "@/components/detect/patch-button";
import { getDb } from "@/db/client";
import { longDate, money, monthLabel } from "@/lib/format";
import { requireUser } from "@/server/auth/session";
import { listSubscriptions, type SubscriptionView } from "@/server/detect/read";
import { filterHref } from "@/server/finance/transactions";

export const metadata: Metadata = { title: "Subscriptions" };

const CADENCE: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Every 3 months",
  annual: "Yearly",
};
const STATUS: Record<SubscriptionView["status"], string> = {
  active: "Active",
  overdue: "Overdue: last charge missed",
  possibly_cancelled: "Possibly cancelled",
  ignored: "Ignored",
};

export default async function SubscriptionsPage() {
  const user = await requireUser();
  const { items, monthlyCents } = await listSubscriptions(getDb(), user.id, {
    includeIgnored: true,
  });
  const shown = items.filter((s) => !s.ignored);
  const ignored = items.filter((s) => s.ignored);

  if (!items.length) {
    return (
      <>
        <PageTitle title="Subscriptions">
          Recurring charges, what they cost per month, when they&rsquo;re next due, and price
          changes.
        </PageTitle>
        <EmptyState
          title="No subscriptions found yet"
          action={{ href: "/app/import", label: "Import a statement" }}
        >
          Once three or more months are imported, recurring charges are detected automatically,
          including price rises and free trials that turned into paid plans.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageTitle title="Subscriptions">
        Found from your statements: three or more charges on a regular schedule at a steady price.
      </PageTitle>
      <p className="tabular text-[15px]">
        <span className="text-[24px] font-semibold tracking-tight">{money(monthlyCents)}</span>
        <span className="text-muted">
          {" "}
          a month across {shown.filter((s) => s.status !== "possibly_cancelled").length} running
          subscriptions
        </span>
      </p>

      <ul className="mt-6">
        {shown.map((s) => (
          <li key={s.id} className="border-t border-rule py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <Link
                href={filterHref({ merchant: s.merchant })}
                className="text-[17px] font-medium hover:underline"
              >
                {s.merchant}
              </Link>
              <span className="tabular text-[15px]">
                {money(s.amountCents)}{" "}
                <span className="text-muted">
                  {CADENCE[s.cadence]?.toLowerCase()}
                  {s.cadence !== "monthly" && ` · ${money(s.monthlyCents)}/month`}
                </span>
              </span>
            </div>
            <p className="mt-1 text-[13px] text-muted">
              <span className={s.status === "active" ? "" : "text-warn"}>{STATUS[s.status]}</span>
              {s.nextExpectedDate && s.status !== "possibly_cancelled" && (
                <> · next around {longDate(s.nextExpectedDate)}</>
              )}
              {s.lastChargeDate && <> · last charged {longDate(s.lastChargeDate)}</>}
              {s.firstChargeDate && (
                <>
                  {" "}
                  · since {monthLabel(s.firstChargeDate.slice(0, 7), "medium")} ({s.charges}{" "}
                  charges)
                </>
              )}
            </p>
            {s.previousAmountCents !== null && s.priceChangedOn && (
              <p className="mt-1 text-[13px]">
                Price {s.amountCents > s.previousAmountCents ? "rose" : "changed"} from{" "}
                {money(s.previousAmountCents)} to {money(s.amountCents)} on{" "}
                {longDate(s.priceChangedOn)}.
              </p>
            )}
            <div className="mt-2">
              <PatchButton
                url={`/api/subscriptions/${s.id}`}
                body={{ ignored: true }}
                label={`Ignore ${s.merchant}`}
                className="text-muted"
              >
                Not a subscription? Ignore
              </PatchButton>
            </div>
          </li>
        ))}
      </ul>

      {ignored.length > 0 && (
        <details className="mt-8 border-t border-rule pt-4">
          <summary className="cursor-pointer text-[13px] text-muted">
            {ignored.length} ignored
          </summary>
          <ul className="mt-2">
            {ignored.map((s) => (
              <li key={s.id} className="flex justify-between py-2 text-[15px]">
                <span>{s.merchant}</span>
                <PatchButton
                  url={`/api/subscriptions/${s.id}`}
                  body={{ ignored: false }}
                  label={`Show ${s.merchant} again`}
                >
                  Show again
                </PatchButton>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
