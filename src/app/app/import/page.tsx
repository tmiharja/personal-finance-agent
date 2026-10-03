import type { Metadata } from "next";
import PageTitle from "@/components/app/page-title";
import EmptyState from "@/components/empty-state";
import ImportFlow from "@/components/import/import-flow";
import { getDb } from "@/db/client";
import { requireUser } from "@/server/auth/session";
import { masterKeys } from "@/server/http";
import { getImportPreview } from "@/server/import/service";

export const metadata: Metadata = { title: "Import" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const user = await requireUser();
  if (user.isDemo) {
    return (
      <>
        <PageTitle title="Import statements" />
        <EmptyState
          title="Imports are off in the demo"
          action={{ href: "/login", label: "Create an account" }}
        >
          The demo already holds 12 months of the fictional Alex Tan&rsquo;s DBS and UOB card
          statements. Create an account to import your own; they&rsquo;re read in memory and the
          files are discarded.
        </EmptyState>
      </>
    );
  }
  const { id } = await searchParams;
  const initial =
    id && UUID.test(id) ? await getImportPreview(getDb(), user.id, masterKeys(), id) : null;
  return (
    <>
      <PageTitle title="Import statements">
        Each statement is reconciled against its printed totals or balances and shown to you first.
        Transfers between your own accounts and card bills paid from your bank are matched up.
        Nothing is saved until you approve it.
      </PageTitle>
      <ImportFlow initial={initial} />
      <p className="mt-10 text-[13px] text-muted">
        Never stored: the file itself, card numbers, account numbers, your name or address, the
        names of people you pay or are paid by, or PDF passwords.
      </p>
    </>
  );
}
