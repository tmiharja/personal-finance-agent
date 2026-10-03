"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { proposalErrorMessage } from "@/components/proposals/messages";

/** ACT-9: undo a change within 30 days (refused if anything it touched changed since). */
export default function UndoButton({ proposalId, title }: { proposalId: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="whitespace-nowrap">
      <button
        type="button"
        disabled={busy}
        aria-label={`Undo: ${title}`}
        className="link text-[13px] disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await fetch(`/api/proposals/${proposalId}/undo`, { method: "POST" });
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            if (!res.ok) setError(proposalErrorMessage(body.error ?? ""));
            else router.refresh();
          } catch {
            setError(proposalErrorMessage(""));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Undoing…" : "Undo"}
      </button>
      {error && (
        <span role="alert" className="mt-1 block text-[12px] whitespace-normal text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
