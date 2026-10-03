import type { Metadata } from "next";
import EmptyState from "@/components/empty-state";
import PageTitle from "@/components/app/page-title";

export const metadata: Metadata = { title: "Subscriptions" };

export default function Page() {
  return (
    <>
      <PageTitle title="Subscriptions">
        Recurring charges, what they cost per month, when they’re next due, and price changes.
      </PageTitle>
      <EmptyState
        title="No subscriptions found yet"
        action={{ href: "/app/import", label: "Import a statement" }}
      >
        Once a few months are imported, recurring charges are detected automatically, including
        price rises and free trials that turned into paid plans.
      </EmptyState>
    </>
  );
}
