"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import AskButton from "@/components/ask/ask-button";
import { cn } from "@/lib/utils";

export const APP_NAV = [
  { href: "/app", label: "Overview" },
  { href: "/app/transactions", label: "Transactions" },
  { href: "/app/subscriptions", label: "Subscriptions" },
  { href: "/app/bills", label: "Bills" },
  { href: "/app/alerts", label: "Alerts" },
  { href: "/app/activity", label: "Activity" },
] as const;

// PRD §8: Overview, Transactions, Ask, Activity, More.
const TABS = [
  { href: "/app", label: "Overview" },
  { href: "/app/transactions", label: "Transactions" },
  { href: "#ask", label: "Ask" },
  { href: "/app/activity", label: "Activity" },
  { href: "/app/settings", label: "More" },
] as const;

function useIsActive() {
  const path = usePathname();
  return (href: string) => (href === "/app" ? path === "/app" : path.startsWith(href));
}

/** Desktop top nav. */
export function AppNav() {
  const isActive = useIsActive();
  return (
    <ul className="hidden gap-5 md:flex">
      {APP_NAV.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            aria-current={isActive(item.href) ? "page" : undefined}
            className={cn(
              "text-sm transition-colors duration-200",
              isActive(item.href)
                ? "font-medium text-foreground"
                : "text-muted hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Mobile bottom tab bar (PRD §8). */
export function TabBar() {
  const isActive = useIsActive();
  return (
    <nav aria-label="App" className="tab-bar">
      <ul className="grid grid-cols-5">
        {TABS.map((item) => (
          <li key={item.href}>
            {item.href === "#ask" ? (
              <AskButton className="flex h-14 w-full items-center justify-center text-[12px] text-muted">
                Ask
              </AskButton>
            ) : (
              <Link
                href={item.href}
                aria-current={isActive(item.href) ? "page" : undefined}
                className={cn(
                  "flex h-14 items-center justify-center text-[12px]",
                  isActive(item.href) ? "font-semibold text-accent" : "text-muted",
                )}
              >
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
