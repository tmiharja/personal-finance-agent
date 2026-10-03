import type { Metadata } from "next";
import EmptyState from "@/components/empty-state";
import PageTitle from "@/components/app/page-title";
import { getDb } from "@/db/client";
import { requireUser } from "@/server/auth/session";
import { getOverviewCounts } from "@/server/finance/overview";

export const metadata: Metadata = { title: "Overview" };

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00+08:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Singapore",
  });

export default async function OverviewPage() {
  const user = await requireUser();
  const counts = await getOverviewCounts(getDb(), user.id);

  if (counts.transactions === 0) {
    return (
      <>
        <PageTitle title="Overview">
          Your month at a glance, once there’s something to show.
        </PageTitle>
        <EmptyState
          title="No statements yet"
          action={{ href: "/app/import", label: "Import a statement" }}
          note="DBS and UOB credit-card PDFs are supported first. Files are read in memory and discarded."
        >
          Import a few months of statements and this page will show spend by category, upcoming
          bills, open alerts and your subscriptions total.
        </EmptyState>
      </>
    );
  }

  const rows: [string, string][] = [
    ["Cards", String(counts.cards)],
    ["Card statements", String(counts.statements)],
    ["Transactions", counts.transactions.toLocaleString("en-SG")],
    ["Latest statement", counts.latestStatement ? fmtDate(counts.latestStatement) : "—"],
  ];
  return (
    <>
      <PageTitle title="Overview">
        Spend by category, bills and alerts arrive in the next phases.
      </PageTitle>
      <dl className="max-w-[560px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between border-t border-rule py-4 text-[15px]">
            <dt className="text-muted">{k}</dt>
            <dd className="tabular font-medium">{v}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
