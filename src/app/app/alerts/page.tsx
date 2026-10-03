import type { Metadata } from "next";
import EmptyState from "@/components/empty-state";
import PageTitle from "@/components/app/page-title";

export const metadata: Metadata = { title: "Alerts" };

export default function Page() {
  return (
    <>
      <PageTitle title="Alerts">
        Unusual charges, duplicates, card fees and bills due soon, each with a plain-English reason.
      </PageTitle>
      <EmptyState title="No alerts" action={{ href: "/app/import", label: "Import a statement" }}>
        Detectors run after every import and once a day. Every alert says why it was raised.
      </EmptyState>
    </>
  );
}
