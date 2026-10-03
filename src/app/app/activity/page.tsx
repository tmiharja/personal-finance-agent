import type { Metadata } from "next";
import EmptyState from "@/components/empty-state";
import PageTitle from "@/components/app/page-title";

export const metadata: Metadata = { title: "Activity" };

export default function Page() {
  return (
    <>
      <PageTitle title="Activity">
        Pending approvals and the full history of what was proposed, approved, rejected and undone.
      </PageTitle>
      <EmptyState
        title="Nothing waiting for you"
        action={{ href: "/app/import", label: "Import a statement" }}
      >
        When the agent or a detector suggests a change, it appears here (and inline in Ask) as a
        proposal. Nothing changes until you approve it.
      </EmptyState>
    </>
  );
}
