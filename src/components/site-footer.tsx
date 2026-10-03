import Link from "next/link";
import { site } from "@/lib/site";

export default function SiteFooter() {
  return (
    <footer className="page-col pb-12">
      <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-rule pt-8 text-[13px] text-muted">
        <Link href="/privacy" className="link">
          Privacy
        </Link>
        <span>Not financial advice</span>
        <span>
          Built by{" "}
          {site.portfolioUrl ? (
            <a href={site.portfolioUrl} className="link" target="_blank" rel="noopener noreferrer">
              {site.credit}
            </a>
          ) : (
            site.credit
          )}
        </span>
        <span>©&nbsp;{new Date().getFullYear()}</span>
      </div>
    </footer>
  );
}
