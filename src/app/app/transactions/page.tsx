import type { Metadata } from "next";
import Link from "next/link";
import ExportButton from "@/components/settings/export-button";
import EmptyState from "@/components/empty-state";
import PageTitle from "@/components/app/page-title";
import TxnRow from "@/components/transactions/txn-row";
import { buttonVariants } from "@/components/ui/button";
import { getDb } from "@/db/client";
import { longDate, money, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import {
  countToReview,
  filterHref,
  listFilterOptions,
  listTransactions,
  parseTxnFilter,
  type TxnFilter,
} from "@/server/finance/transactions";
import { masterKeys } from "@/server/http";

export const metadata: Metadata = { title: "Transactions" };

const input = "h-9 rounded-md border border-rule bg-background px-2 text-[13px] text-foreground";

function describe(f: TxnFilter, cardName?: string): string[] {
  const parts: string[] = [];
  if (f.from && f.to) parts.push(`${longDate(f.from)} – ${longDate(f.to)}`);
  else if (f.from) parts.push(`from ${longDate(f.from)}`);
  else if (f.to) parts.push(`until ${longDate(f.to)}`);
  if (f.category) parts.push(f.category);
  if (f.merchant) parts.push(f.merchant);
  if (f.q) parts.push(`“${f.q}”`);
  if (cardName) parts.push(titleCase(cardName));
  if (f.review) parts.push("to review");
  if (f.spend) parts.push("spending only");
  return parts;
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const filter = parseTxnFilter(await searchParams);
  const db = getDb();
  const [page, options, toReview] = await Promise.all([
    listTransactions(db, user.id, masterKeys(), filter),
    listFilterOptions(db, user.id),
    countToReview(db, user.id),
  ]);
  const filtered = describe(filter).length > 0;
  const cardName = options.cards.find((c) => c.id === filter.account)?.name;

  if (!filtered && page.total === 0) {
    return (
      <>
        <PageTitle title="Transactions">
          Every transaction across your cards, searchable and filterable, with categories you can
          correct.
        </PageTitle>
        <EmptyState
          title="Nothing to show yet"
          action={{ href: "/app/import", label: "Import a statement" }}
        >
          Imported transactions appear here. Corrections you make can become rules, which you
          approve first.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageTitle title="Transactions">
        Search by merchant, filter by date, card or account, or category, and correct any category.
      </PageTitle>

      <form method="get" className="flex flex-wrap items-end gap-2" role="search">
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          Merchant
          <input
            name="q"
            defaultValue={filter.q}
            placeholder="e.g. Grab"
            className={cn(input, "w-36")}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          Category
          <select name="category" defaultValue={filter.category ?? ""} className={input}>
            <option value="">All</option>
            {options.categories.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {options.cards.length > 1 && (
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Card or account
            <select name="account" defaultValue={filter.account ?? ""} className={input}>
              <option value="">All</option>
              {options.cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {titleCase(c.name)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          From
          <input type="date" name="from" defaultValue={filter.from} className={input} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          To
          <input type="date" name="to" defaultValue={filter.to} className={input} />
        </label>
        {filter.merchant && <input type="hidden" name="merchant" value={filter.merchant} />}
        {filter.spend && <input type="hidden" name="spend" value="1" />}
        {filter.review && <input type="hidden" name="review" value="1" />}
        <button type="submit" className={buttonVariants({ size: "sm", className: "h-9" })}>
          Filter
        </button>
        {filtered && (
          <Link href="/app/transactions" className="link mb-2 text-[13px]">
            Clear
          </Link>
        )}
      </form>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 border-b border-rule pb-3">
        <p className="tabular text-[15px]" aria-live="polite">
          {page.total.toLocaleString("en-SG")} {page.total === 1 ? "transaction" : "transactions"}
          {filtered && (
            <span className="text-muted"> · {describe(filter, cardName).join(" · ")}</span>
          )}
          {page.total > 0 && <span className="text-muted"> · net {money(page.totalCents)}</span>}
        </p>
        <span className="flex items-baseline gap-4">
          {toReview > 0 && !filter.review && (
            <Link href={filterHref({ review: "1" })} className="text-[13px] text-warn">
              {toReview} to review
            </Link>
          )}
          {page.total > 0 && (
            <ExportButton
              filter={{
                from: filter.from,
                to: filter.to,
                account: filter.account,
                category: filter.category,
                merchant: filter.merchant,
                q: filter.q,
                review: filter.review,
                spend: filter.spend,
              }}
            />
          )}
        </span>
      </div>

      {page.total === 0 ? (
        <p className="mt-8 text-[15px] text-muted">No transactions match these filters.</p>
      ) : (
        <table className="tabular w-full text-[15px]">
          <caption className="sr-only">Transactions, newest first</caption>
          <thead className="sr-only md:not-sr-only">
            <tr className="text-left text-[12px] text-muted">
              <th className="py-2 pr-3 font-normal">Date</th>
              <th className="py-2 pr-3 font-normal">Merchant</th>
              <th className="hidden py-2 pr-3 font-normal md:table-cell">Card or account</th>
              <th className="py-2 pr-3 font-normal">Category</th>
              <th className="py-2 text-right font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((r) => (
              <TxnRow key={r.id} row={r} categories={options.categories} />
            ))}
          </tbody>
        </table>
      )}

      {page.pages > 1 && (
        <nav aria-label="Pages" className="mt-6 flex items-center justify-between text-[13px]">
          {page.page > 1 ? (
            <Link href={filterHref({ ...filter, page: page.page - 1 })} className="link">
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted">
            Page {page.page} of {page.pages}
          </span>
          {page.page < page.pages ? (
            <Link href={filterHref({ ...filter, page: page.page + 1 })} className="link">
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}
