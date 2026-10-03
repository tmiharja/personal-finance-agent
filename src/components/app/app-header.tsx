import Link from "next/link";
import HeaderShell from "@/components/header-shell";
import ThemeToggle from "@/components/theme-toggle";
import { site } from "@/lib/site";
import AskButton from "@/components/ask/ask-button";
import { AppNav } from "./app-nav";

export default function AppHeader({ pendingApprovals }: { pendingApprovals: number }) {
  return (
    <HeaderShell>
      <div className="site-header__inner page-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-10 focus:bg-background focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <nav aria-label="Primary" className="flex items-center justify-between gap-6 text-sm">
          <div className="flex items-center gap-8">
            <Link href="/app" className="shrink-0 text-[15px] font-semibold tracking-tight">
              {site.name}
            </Link>
            <AppNav />
          </div>
          <div className="flex items-center gap-4">
            <AskButton className="hidden rounded-full border border-rule px-3 py-1 text-[13px] hover:bg-accent-soft md:inline-block" />
            <Link href="/app/import" className="link">
              Import
            </Link>
            <Link
              href="/app/activity"
              className="flex items-center gap-1.5 text-muted transition-colors hover:text-foreground"
              aria-label={`Approvals: ${pendingApprovals} pending`}
            >
              <span className="hidden sm:inline">Approvals</span>
              <span className="tabular rounded-full bg-accent-soft px-2 py-0.5 text-[12px] font-medium text-accent">
                {pendingApprovals}
              </span>
            </Link>
            <Link
              href="/app/settings"
              className="hidden text-muted hover:text-foreground md:inline"
            >
              Settings
            </Link>
            <ThemeToggle />
          </div>
        </nav>
      </div>
    </HeaderShell>
  );
}
