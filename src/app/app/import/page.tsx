import type { Metadata } from "next";
import PageTitle from "@/components/app/page-title";
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
  const { id } = await searchParams;
  const initial =
    id && UUID.test(id) ? await getImportPreview(getDb(), user.id, masterKeys(), id) : null;
  return (
    <>
      <PageTitle title="Import statements">
        Each statement is reconciled against its printed totals and shown to you first. Nothing is
        saved until you approve it.
      </PageTitle>
      <ImportFlow initial={initial} />
      <p className="mt-10 text-[13px] text-muted">
        Never stored: the file itself, card numbers, cardholder names, addresses, account numbers or
        PDF passwords.
      </p>
    </>
  );
}
