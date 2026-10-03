"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

/** A small action that PATCHes JSON to the API, then refreshes the page. */
export default function PatchButton({
  url,
  body,
  children,
  className,
  label,
}: {
  url: string;
  body: Record<string, unknown>;
  children: React.ReactNode;
  className?: string;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={label}
        disabled={busy}
        className={cn("link text-[13px] disabled:opacity-50", className)}
        onClick={async () => {
          setBusy(true);
          setFailed(false);
          const res = await fetch(url, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          setBusy(false);
          if (!res.ok) setFailed(true);
          else router.refresh();
        }}
      >
        {children}
      </button>
      {failed && (
        <span role="alert" className="ml-2 text-[12px] text-danger">
          Couldn&rsquo;t save. Try again.
        </span>
      )}
    </>
  );
}
