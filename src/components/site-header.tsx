import Link from "next/link";
import { site } from "@/lib/site";
import HeaderShell from "./header-shell";
import ThemeToggle from "./theme-toggle";

/** Marketing header (landing, sign-in, privacy). Mirrors the portfolio's. */
export default function SiteHeader() {
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
          <Link href="/" className="shrink-0 text-[15px] font-semibold tracking-tight">
            {site.name}
          </Link>
          <div className="flex items-center gap-5">
            <ul className="flex gap-5 text-muted">
              <li className="hidden sm:block">
                <Link href="/#how-it-works" className="link text-muted! hover:text-foreground!">
                  How it works
                </Link>
              </li>
              <li>
                <Link href="/privacy" className="link text-muted! hover:text-foreground!">
                  Privacy
                </Link>
              </li>
              <li>
                <Link href="/login" className="link">
                  Sign in
                </Link>
              </li>
            </ul>
            <ThemeToggle />
          </div>
        </nav>
      </div>
    </HeaderShell>
  );
}
