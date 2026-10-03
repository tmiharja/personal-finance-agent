import type { ReactNode } from "react";
import AppHeader from "@/components/app/app-header";
import AskPanel from "@/components/ask/ask-panel";
import { TabBar } from "@/components/app/app-nav";
import SiteFooter from "@/components/site-footer";
import { getDb } from "@/db/client";
import { requireUser } from "@/server/auth/session";
import { getOverviewCounts } from "@/server/finance/overview";

// Every /app request validates the session against the database (proxy.ts only
// checks that a cookie exists).
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const { pendingApprovals } = await getOverviewCounts(getDb(), user.id);
  return (
    <div className="app-shell flex min-h-full flex-1 flex-col pb-14 md:pb-0">
      <AppHeader pendingApprovals={pendingApprovals} />
      <main id="main" className="page-col flex-1 pt-32 pb-[72px]">
        {children}
      </main>
      <SiteFooter />
      <TabBar />
      <AskPanel />
    </div>
  );
}
