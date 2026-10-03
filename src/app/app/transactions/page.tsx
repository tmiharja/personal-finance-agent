import type { Metadata } from "next";
import EmptyState from "@/components/empty-state";
import PageTitle from "@/components/app/page-title";

export const metadata: Metadata = { title: "Transactions" };

export default function Page() {
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
        Imported transactions appear here. Corrections you make can become rules, which you approve
        first.
      </EmptyState>
    </>
  );
}
