import type { Metadata } from "next";
import EmptyState from "@/components/empty-state";
import PageTitle from "@/components/app/page-title";

export const metadata: Metadata = { title: "Import" };

export default function ImportPage() {
  return (
    <>
      <PageTitle title="Import statements">
        Drop DBS or UOB credit-card PDFs. Each one is reconciled against its printed totals and
        shown to you as a preview; nothing is saved until you approve it.
      </PageTitle>
      <EmptyState
        title="Upload is coming in Phase 1"
        note="Never stored: the file, card numbers, cardholder names, addresses, account numbers or PDF passwords."
      >
        The parsers for DBS and UOB card statements are specified and have 24 synthetic test
        statements ready.
      </EmptyState>
    </>
  );
}
