import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/empty-state";
import PageTitle from "@/components/app/page-title";
import { getDb } from "@/db/client";
import { dueLabel, longDate, money, titleCase } from "@/lib/format";
import { todaySgt } from "@/server/agent/period";
import { requireUser } from "@/server/auth/session";
import { listBills } from "@/server/detect/read";
import { filterHref } from "@/server/finance/transactions";
import BillForm from "@/components/settings/bill-form";
import ManualBillEdit from "@/components/settings/manual-bill";

function AddBill() {
  return (
    <section aria-labelledby="add-bill-heading" className="mt-12">
      <h2 id="add-bill-heading" className="text-[17px] font-semibold">
        Add a bill
      </h2>
      <p className="mt-1 mb-3 text-[13px] text-muted">
        For a bill your statements don&rsquo;t show, like one paid in cash or from another bank. You
        can undo it from Activity.
      </p>
      <BillForm />
    </section>
  );
}

export const metadata: Metadata = { title: "Bills" };

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

export default async function BillsPage() {
  const user = await requireUser();
  const { cards, bills } = await listBills(getDb(), user.id);
  const today = todaySgt();

  if (!cards.length && !bills.length) {
    return (
      <>
        <PageTitle title="Bills">Card payment due dates and recurring bills.</PageTitle>
        <EmptyState
          title="No bills yet"
          action={{ href: "/app/import", label: "Import a statement" }}
        >
          Card due dates come from your statements. Recurring bills (telco, utilities, insurance)
          are found once three months are imported.
        </EmptyState>
        <AddBill />
      </>
    );
  }

  return (
    <>
      <PageTitle title="Bills">
        Card payment due dates from your latest statements, and recurring bills found in your
        spending.
      </PageTitle>

      <section aria-labelledby="cards-heading">
        <h2 id="cards-heading" className="text-[17px] font-semibold">
          Card payments
        </h2>
        <ul className="mt-3">
          {cards.map((c) => {
            const state = c.paid
              ? "Paid"
              : c.dueDate
                ? dueLabel(today, c.dueDate).replace(/^due/, "Due")
                : "No due date";
            const late = !c.paid && c.dueDate !== null && c.dueDate < today;
            return (
              <li
                key={c.accountId}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-rule py-4"
              >
                <span>
                  <span className="block text-[15px] font-medium">{titleCase(c.card)}</span>
                  <span className="block text-[13px] text-muted">
                    Statement {longDate(c.statementDate)}
                    {c.dueDate && <> · due {longDate(c.dueDate)}</>}
                    {c.minimumPaymentCents !== null && (
                      <> · minimum {money(c.minimumPaymentCents)}</>
                    )}
                  </span>
                </span>
                <span className="tabular text-right">
                  <span className="block text-[15px]">{money(c.totalCents)}</span>
                  <span
                    className={`block text-[13px] ${late ? "text-danger" : c.paid ? "text-muted" : "text-warn"}`}
                  >
                    {state}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[12px] text-muted">
          &ldquo;Paid&rdquo; means a payment to the card appears after the statement: in a later
          card statement, or in one of your bank accounts as soon as you import it.
        </p>
      </section>

      <section aria-labelledby="bills-heading" className="mt-12">
        <h2 id="bills-heading" className="text-[17px] font-semibold">
          Recurring bills
        </h2>
        {bills.length === 0 ? (
          <p className="mt-3 text-[15px] text-muted">None found yet.</p>
        ) : (
          <ul className="mt-3">
            {bills.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-rule py-4"
              >
                <span>
                  <Link
                    href={filterHref({ merchant: b.payee })}
                    className="block text-[15px] font-medium hover:underline"
                  >
                    {b.payee}
                  </Link>
                  <span className="block text-[13px] text-muted">
                    {b.source === "manual" && <>Added by you · </>}
                    {b.dueDay && <>Around the {ordinal(b.dueDay)} each month</>}
                    {b.card && <> · on {titleCase(b.card)}</>}
                    {b.lastPaidOn && (
                      <>
                        {" "}
                        · last {money(b.lastAmountCents ?? 0)} on {longDate(b.lastPaidOn)}
                      </>
                    )}
                  </span>
                </span>
                <span className="tabular text-right">
                  <span className="block text-[15px]">
                    {b.expectedAmountCents === null
                      ? "Amount varies"
                      : `~${money(b.expectedAmountCents)}`}
                  </span>
                  <span
                    className={`block text-[13px] ${b.status === "overdue" ? "text-warn" : "text-muted"}`}
                  >
                    {b.status === "overdue"
                      ? "Expected charge missing"
                      : b.nextDueDate
                        ? `Next ${longDate(b.nextDueDate)}`
                        : ""}
                  </span>
                </span>
                {b.source === "manual" && <ManualBillEdit bill={b} />}
              </li>
            ))}
          </ul>
        )}
      </section>
      <AddBill />
    </>
  );
}
