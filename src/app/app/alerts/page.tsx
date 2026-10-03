import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/empty-state";
import PageTitle from "@/components/app/page-title";
import PatchButton from "@/components/detect/patch-button";
import { getDb } from "@/db/client";
import { longDate, money, shortDate } from "@/lib/format";
import { requireUser } from "@/server/auth/session";
import { listAlerts, type AlertView } from "@/server/detect/read";

export const metadata: Metadata = { title: "Alerts" };

/** DET-8: the type is always written out, never shown by colour alone. */
const TYPE_LABEL: Record<AlertView["type"], string> = {
  price_increase: "Price rise",
  trial_conversion: "Trial now paid",
  unusual_amount: "Unusual amount",
  first_time_merchant: "New merchant",
  duplicate_charge: "Possible duplicate",
  foreign_charge: "Foreign currency",
  card_fee: "Card fee",
  bill_due: "Payment due",
};
const STATUS_LABEL = {
  open: "Open",
  dismissed: "Dismissed",
  expected: "Marked as expected",
} as const;

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const user = await requireUser();
  const closed = (await searchParams).show === "closed";
  const items = await listAlerts(getDb(), user.id, { status: closed ? "closed" : "open" });

  return (
    <>
      <PageTitle title="Alerts">
        Unusual charges, duplicates, price rises, card fees and payments due, each with the reason
        it was raised.
      </PageTitle>
      <nav aria-label="Alert filter" className="mb-4 flex gap-4 text-[13px]">
        <Link
          href="/app/alerts"
          aria-current={!closed ? "page" : undefined}
          className={!closed ? "font-semibold" : "link"}
        >
          Open
        </Link>
        <Link
          href="/app/alerts?show=closed"
          aria-current={closed ? "page" : undefined}
          className={closed ? "font-semibold" : "link"}
        >
          Dismissed and expected
        </Link>
      </nav>

      {items.length === 0 ? (
        closed ? (
          <p className="border-t border-rule pt-6 text-[15px] text-muted">Nothing dismissed yet.</p>
        ) : (
          <EmptyState
            title="No open alerts"
            action={{ href: "/app/import", label: "Import a statement" }}
          >
            Detectors run after every import and once a day. Every alert says why it was raised.
          </EmptyState>
        )
      ) : (
        <ul>
          {items.map((a) => (
            <li key={a.id} className="border-t border-rule py-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="rounded-full border border-rule px-2.5 py-0.5 text-[12px] font-medium">
                  {TYPE_LABEL[a.type]}
                </span>
                {a.occurredOn && (
                  <span className="text-[13px] text-muted">{longDate(a.occurredOn)}</span>
                )}
              </div>
              <p className="mt-2 text-[15px] leading-relaxed">{a.reason}</p>
              {a.transactions.length > 0 && (
                <ul className="tabular mt-2 text-[13px] text-muted">
                  {a.transactions.map((t) => (
                    <li key={t.id}>
                      {shortDate(t.date)} · {t.merchant} · {money(t.amountCents)}
                    </li>
                  ))}
                  {a.more > 0 && <li>and {a.more} more</li>}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap gap-4">
                {a.status === "open" ? (
                  <>
                    <PatchButton
                      url={`/api/alerts/${a.id}`}
                      body={{ status: "dismissed" }}
                      label={`Dismiss: ${TYPE_LABEL[a.type]}`}
                    >
                      Dismiss
                    </PatchButton>
                    <PatchButton
                      url={`/api/alerts/${a.id}`}
                      body={{ status: "expected" }}
                      label={`Mark as expected: ${TYPE_LABEL[a.type]}`}
                    >
                      This was expected
                    </PatchButton>
                  </>
                ) : (
                  <>
                    <span className="text-[13px] text-muted">{STATUS_LABEL[a.status]}</span>
                    <PatchButton
                      url={`/api/alerts/${a.id}`}
                      body={{ status: "open" }}
                      label={`Reopen: ${TYPE_LABEL[a.type]}`}
                    >
                      Reopen
                    </PatchButton>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
