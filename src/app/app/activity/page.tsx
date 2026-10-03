import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/empty-state";
import PageTitle from "@/components/app/page-title";
import PendingList from "@/components/activity/pending-list";
import UndoButton from "@/components/activity/undo-button";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db/client";
import { ACTION_LABEL, PROPOSER_LABEL, STATE_LABEL } from "@/lib/actions";
import { longDate, shortDate } from "@/lib/format";
import {
  ACTION_STATES,
  listActionHistory,
  type ActionState,
  type ActionType,
  type HistoryFilter,
  type Proposer,
} from "@/server/actions";
import { requireUser } from "@/server/auth/session";
import { listPendingProposals } from "@/server/import/service";

export const metadata: Metadata = { title: "Activity" };

/** "14 Mar, 09:05" in Singapore time. */
const when = (iso: string) => {
  const sgt = new Date(Date.parse(iso) + 8 * 3600_000).toISOString();
  return `${shortDate(sgt.slice(0, 10))}, ${sgt.slice(11, 16)}`;
};

const PROPOSERS = ["user", "agent", "detector", "system"] as const;

/** Only known values pass; anything else is ignored. */
function parseFilter(p: Record<string, string | undefined>): HistoryFilter {
  return {
    proposer: (PROPOSERS as readonly string[]).includes(p.who ?? "")
      ? (p.who as Proposer)
      : undefined,
    type: p.type && p.type in ACTION_LABEL ? (p.type as ActionType) : undefined,
    state: (ACTION_STATES as readonly string[]).includes(p.state ?? "")
      ? (p.state as ActionState)
      : undefined,
  };
}

const select = "rounded-md border border-rule bg-background px-2 py-1 text-[13px]";

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const filter = parseFilter(await searchParams);
  const filtered = Boolean(filter.proposer || filter.type || filter.state);
  const [pending, history] = await Promise.all([
    listPendingProposals(getDb(), user.id),
    listActionHistory(getDb(), user.id, filter),
  ]);
  const imports = pending.flatMap((p) => (p.type === "commit_import" ? [p] : []));
  const actions = pending.flatMap((p) => (p.type !== "commit_import" ? [p] : []));

  return (
    <>
      <PageTitle title="Activity">
        What&rsquo;s waiting for your approval, and every change made to your data. Undo any change
        for 30 days.
      </PageTitle>
      <section aria-labelledby="pending-heading">
        <h2 id="pending-heading" className="text-[17px] font-semibold">
          Waiting for approval
        </h2>
        {imports.length > 0 && (
          <ul className="mt-3">
            {imports.map((p) => (
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
        )}
        {/* Always mounted, so a batch result stays on screen after the list empties. */}
        <PendingList
          items={actions.map((p) => ({ id: p.id, proposer: p.proposer, preview: p.preview }))}
        >
          {pending.length === 0 && (
            <div className="mt-3">
              <EmptyState
                title="Nothing waiting for you"
                action={{ href: "/app/import", label: "Import a statement" }}
              >
                When an import or a change suggested by Ask needs your approval, it appears here.
                Nothing changes until you approve it.
              </EmptyState>
            </div>
          )}
        </PendingList>
      </section>

      <section aria-labelledby="history-heading" className="mt-12">
        <h2 id="history-heading" className="text-[17px] font-semibold">
          History
        </h2>
        <form
          method="get"
          className="mt-3 flex flex-wrap items-end gap-3"
          aria-label="Filter history"
        >
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Who
            <select name="who" defaultValue={filter.proposer ?? ""} className={select}>
              <option value="">Anyone</option>
              {PROPOSERS.map((p) => (
                <option key={p} value={p}>
                  {PROPOSER_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Change
            <select name="type" defaultValue={filter.type ?? ""} className={select}>
              <option value="">Any change</option>
              {Object.entries(ACTION_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Outcome
            <select name="state" defaultValue={filter.state ?? ""} className={select}>
              <option value="">Any outcome</option>
              {ACTION_STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="secondary" type="submit">
            Filter
          </Button>
          {filtered && (
            <Link href="/app/activity" className="link pb-1 text-[13px]">
              Clear
            </Link>
          )}
        </form>
        {history.length === 0 ? (
          <p className="mt-4 text-[15px] text-muted">
            {filtered ? "Nothing matches these filters." : "Nothing yet."}
          </p>
        ) : (
          <ul className="mt-3">
            {history.map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-rule py-3 text-[15px]"
              >
                <span className="min-w-0">
                  {h.title}
                  <span className="block text-[13px] text-muted">
                    {STATE_LABEL[h.state]} · {PROPOSER_LABEL[h.proposer] ?? h.proposer}
                    {h.proposer === "agent" && (h.state === "done" || h.state === "undone")
                      ? " suggested, you approved"
                      : ""}{" "}
                    · <span className="tabular">{when(h.at)}</span>
                  </span>
                </span>
                {h.canUndo && <UndoButton proposalId={h.id} title={h.title} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
