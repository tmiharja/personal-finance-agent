"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { money, shortDate } from "@/lib/format";
import type { ActionPreview } from "@/server/actions/engine";
import { proposalErrorMessage } from "./messages";

/**
 * Any proposed change (PRD ACT-4): the preview is built by the server from
 * structured data, never model text. Approve applies exactly what it shows.
 */
export default function ProposalCard({
  proposalId,
  preview,
  from,
  selected,
  onSelect,
  onDone,
}: {
  proposalId: string;
  preview: ActionPreview;
  /** Who suggested it, when it wasn't you. */
  from?: "assistant" | "app";
  /** Batch approval (ACT-5): a checkbox when the list offers one. */
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  onDone?: (outcome: "approved" | "rejected") => void;
}) {
  const router = useRouter();
  const [state, setState] = useState<"pending" | "busy" | "approved" | "rejected">("pending");
  const [error, setError] = useState<string | null>(null);
  const title = preview.title ?? "Suggested change";

  async function decide(decision: "approve" | "reject") {
    setState("busy");
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/${decision}`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(proposalErrorMessage(body.error ?? ""));
        setState("pending");
        return;
      }
      const outcome = decision === "approve" ? "approved" : "rejected";
      setState(outcome);
      onDone?.(outcome);
      router.refresh();
    } catch {
      setError(proposalErrorMessage(""));
      setState("pending");
    }
  }

  return (
    <section
      aria-label={title}
      className="rounded-r-lg border-l-2 border-accent bg-accent-soft px-5 py-4"
    >
      <div className="flex items-start gap-3">
        {onSelect && state !== "approved" && state !== "rejected" && (
          <input
            type="checkbox"
            aria-label={`Select: ${title}`}
            checked={Boolean(selected)}
            onChange={(e) => onSelect(e.target.checked)}
            className="mt-1 size-4 accent-accent"
          />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold">{title}</h3>
          {from && (
            <p className="text-[12px] text-muted">
              Suggested by {from === "assistant" ? "Ask" : "the app"}. Nothing changes until you
              approve.
            </p>
          )}
          {(preview.lines ?? []).map((l) => (
            <p key={l} className="mt-1 text-[13px] text-muted">
              {l}
            </p>
          ))}
          {(preview.changes ?? []).length > 0 && (
            <ul className="tabular mt-2 text-[13px]">
              {preview.changes!.map((c) => (
                <li key={c.from}>
                  {c.count} × {c.from} → {c.to}
                </li>
              ))}
            </ul>
          )}
          {(preview.sample ?? []).length > 0 && (
            <p className="tabular mt-2 text-[12px] text-muted">
              e.g.{" "}
              {preview
                .sample!.map((r) => `${shortDate(r.txnDate)} ${r.merchant} ${money(r.amountCents)}`)
                .join(" · ")}
            </p>
          )}
          <div className="mt-3">
            {state === "approved" ? (
              <p role="status" className="text-[13px]">
                Done. You can undo it from Activity for 30 days.
              </p>
            ) : state === "rejected" ? (
              <p role="status" className="text-[13px] text-muted">
                Discarded. Nothing changed.
              </p>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => decide("approve")} disabled={state === "busy"}>
                  {state === "busy" ? "Working…" : "Approve"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => decide("reject")}
                  disabled={state === "busy"}
                >
                  Discard
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" className="mt-2 text-[13px] text-danger">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
