"use client";

import { cn } from "@/lib/utils";

export const OPEN_ASK = "finance:open-ask";

/** Opens the Ask panel from anywhere (header, tab bar, empty states). */
export default function AskButton({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_ASK))}
      className={cn("cursor-pointer", className)}
      aria-haspopup="dialog"
    >
      {children ?? "Ask"}
    </button>
  );
}
