import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/empty-state";
import PageTitle from "@/components/app/page-title";
import { getDb } from "@/db/client";
import { longDate } from "@/lib/format";
import { requireUser } from "@/server/auth/session";
import { listPendingProposals, listRecentActivity } from "@/server/import/service";

export const metadata: Metadata = { title: "Activity" };

const EVENT_LABEL: Record<string, string> = {
  proposed: "Proposed",
  approved: "Approved",
  rejected: "Discarded",
  executed: "Done",
  expired: "Expired",
  failed: "Failed",
  undone: "Undone",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Singapore",
  });

export default async function ActivityPage() {
  const user = await requireUser();
  const [pending, recent] = await Promise.all([
    listPendingProposals(getDb(), user.id),
    listRecentActivity(getDb(), user.id),
  ]);
  return (
    <>
      <PageTitle title="Activity">
        What&rsquo;s waiting for your approval, and everything that happened.
      </PageTitle>
      {pending.length === 0 ? (
        <EmptyState
          title="Nothing waiting for you"
          action={{ href: "/app/import", label: "Import a statement" }}
        >
          When an import or a suggested change needs your approval, it appears here. Nothing changes
          until you approve it.
        </EmptyState>
      ) : (
        <section aria-labelledby="pending-heading">
          <h2 id="pending-heading" className="text-[17px] font-semibold">
            Waiting for approval
          </h2>
          <ul className="mt-3">
            {pending.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-t border-rule py-4"
              >
                <span className="text-[15px]">
                  Import {p.summary.bank} statement · {longDate(p.summary.statementDate)} ·{" "}
                  {p.summary.cards.reduce((s, c) => s + c.counts.newRows, 0)} new transactions
                </span>
                <Link href={`/app/import?id=${p.importId}`} className="link text-[15px]">
                  Review
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {recent.length > 0 && (
        <section aria-labelledby="history-heading" className="mt-12">
          <h2 id="history-heading" className="text-[17px] font-semibold">
            History
          </h2>
          <ul className="mt-3">
            {recent.map((e) => (
              <li
                key={e.id}
                className="flex justify-between gap-4 border-t border-rule py-3 text-[15px]"
              >
                <span>
                  {EVENT_LABEL[e.event] ?? e.event}
                  <span className="text-muted"> · {e.actor === "user" ? "you" : "system"}</span>
                </span>
                <span className="tabular text-[13px] text-muted">{when(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
