"use client";

import { useState } from "react";
import type { Draft } from "@/lib/drafts";

/** A draft to copy (ACT-2). Opens in place; nothing is ever sent. */
export default function DraftPanel({
  draft,
  label,
  startOpen = false,
}: {
  draft: Draft;
  label: string;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [copied, setCopied] = useState(false);
  if (!open)
    return (
      <button type="button" className="link text-[13px]" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  return (
    <div
      className="w-full rounded-lg border border-rule px-4 py-3"
      role="region"
      aria-label={draft.title}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold">{draft.title}</h3>
        <span className="flex gap-3 text-[13px]">
          <button
            type="button"
            className="link"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(draft.text);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="link text-muted!" onClick={() => setOpen(false)}>
            Close
          </button>
        </span>
      </div>
      <p className="mt-1 text-[12px] text-muted">
        A draft for you to send yourself. Fill in the [blanks]; the app never sends anything.
      </p>
      <pre className="mt-2 font-sans text-[13px] leading-relaxed whitespace-pre-wrap">
        {draft.text}
      </pre>
    </div>
  );
}
