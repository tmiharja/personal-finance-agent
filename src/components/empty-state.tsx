import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";

/** Calm, honest empty state: what this screen will show, and one next action (PRD §8). */
export default function EmptyState({
  title,
  children,
  action,
  note,
}: {
  title: string;
  children: ReactNode;
  action?: { href: string; label: string };
  note?: string;
}) {
  return (
    <div className="border-t border-rule pt-10">
      <h2 className="text-[24px] font-semibold tracking-tight">{title}</h2>
      <div className="mt-3 max-w-[560px] text-[15px] leading-relaxed text-muted">{children}</div>
      {action && (
        <Link href={action.href} className={buttonVariants({ className: "mt-6" })}>
          {action.label}
        </Link>
      )}
      {note && <p className="mt-6 text-[13px] text-muted">{note}</p>}
    </div>
  );
}
