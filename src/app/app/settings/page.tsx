import type { Metadata } from "next";
import Link from "next/link";
import PageTitle from "@/components/app/page-title";
import SignOutButton from "@/components/app/sign-out-button";
import BudgetRow from "@/components/settings/budget-row";
import DeleteAccount from "@/components/settings/delete-account";
import ExportButton from "@/components/settings/export-button";
import RuleRow from "@/components/settings/rule-row";
import { getDb } from "@/db/client";
import { longDate, titleCase } from "@/lib/format";
import { requireUser } from "@/server/auth/session";
import { isAdmin } from "@/server/admin/stats";
import { getSettings } from "@/server/finance/settings";
import AddPasskey from "./add-passkey";

export const metadata: Metadata = { title: "Settings" };

const h2 = "text-[17px] font-semibold";
const section = "mt-12 max-w-[640px] scroll-mt-24";

export default async function SettingsPage() {
  const user = await requireUser();
  const s = await getSettings(getDb(), user.id);
  return (
    <>
      <PageTitle title="Settings">
        Your account, budgets and rules. Every change here is recorded in Activity, where you can
        undo it for 30 days.
      </PageTitle>

      <section className="max-w-[640px]" aria-labelledby="account-heading">
        <h2 id="account-heading" className={h2}>
          Account
        </h2>
        {user.isDemo ? (
          <p className="mt-4 border-t border-rule py-4 text-[15px] text-muted">
            This is a demo workspace with fictional data. It&rsquo;s deleted 24 hours after you
            opened it. Sign out to leave it now.
          </p>
        ) : (
          <>
            <div className="mt-4 flex justify-between border-t border-rule py-4 text-[15px]">
              <span className="text-muted">Signed in as</span>
              <span>{user.email}</span>
            </div>
            <div className="border-t border-rule py-4">
              <AddPasskey />
            </div>
          </>
        )}
        {isAdmin(user) && (
          <div className="border-t border-rule py-4">
            <Link href="/app/admin" className="link text-[15px]">
              Admin
            </Link>
          </div>
        )}
        <div className="border-t border-rule py-4">
          <SignOutButton className="link text-[15px]" />
        </div>
      </section>

      <section id="accounts" className={section} aria-labelledby="accounts-heading">
        <h2 id="accounts-heading" className={h2}>
          Cards and bank accounts
        </h2>
        {s.accounts.length === 0 ? (
          <p className="mt-3 text-[15px] text-muted">
            None yet.{" "}
            <Link href="/app/import" className="link">
              Import a statement
            </Link>{" "}
            to add one.
          </p>
        ) : (
          <ul className="mt-3">
            {s.accounts.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap justify-between gap-x-4 border-t border-rule py-3 text-[15px]"
              >
                <span>
                  {titleCase(a.name)}
                  <span className="block text-[13px] text-muted">
                    {a.bank} {a.kind === "card" ? "card" : "bank account"}
                  </span>
                </span>
                <span className="text-right text-[13px] text-muted">
                  {a.statements} {a.statements === 1 ? "statement" : "statements"}
                  {a.latest && <span className="block">latest {longDate(a.latest)}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[12px] text-muted">
          Shown by product name only. Card and account numbers are never stored.
        </p>
      </section>

      <section id="budgets" className={section} aria-labelledby="budgets-heading">
        <h2 id="budgets-heading" className={h2}>
          Monthly budgets
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          Shown on Overview against each month&rsquo;s spend. Leave blank for no budget.
        </p>
        <ul className="mt-3">
          {s.budgets.map((b) => (
            <BudgetRow key={b.categoryId} {...b} />
          ))}
        </ul>
      </section>

      <section id="rules" className={section} aria-labelledby="rules-heading">
        <h2 id="rules-heading" className={h2}>
          Rules
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          &ldquo;Always categorise this merchant as…&rdquo;. Changing one moves the transactions it
          categorised; deleting one leaves them as they are.
        </p>
        {s.rules.length === 0 ? (
          <p className="mt-3 text-[15px] text-muted">
            None yet. On Transactions, change a category and choose &ldquo;All … transactions, past
            and future&rdquo;.
          </p>
        ) : (
          <ul className="mt-3">
            {s.rules.map((r) => (
              <RuleRow
                key={r.id}
                ruleId={r.id}
                pattern={r.pattern}
                categoryId={r.categoryId}
                categories={s.ruleCategories}
              />
            ))}
          </ul>
        )}
      </section>

      <section id="data" className={section} aria-labelledby="data-heading">
        <h2 id="data-heading" className={h2}>
          Your data
        </h2>
        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 border-t border-rule py-4 text-[15px]">
          <span>
            Every transaction as a CSV file
            <span className="block text-[13px] text-muted">
              Recorded in Activity. Filter on Transactions to export part of it.
            </span>
          </span>
          <ExportButton label="Export all transactions" />
        </div>
        <div className="border-t border-rule py-4">
          <DeleteAccount />
        </div>
      </section>
    </>
  );
}
