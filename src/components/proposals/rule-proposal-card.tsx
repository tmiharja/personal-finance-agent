"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { money, shortDate } from "@/lib/format";
import type { RulePreview } from "@/server/actions/rules";
import { proposalErrorMessage } from "./messages";

/**
 * A create_rule proposal (PRD ACT-4): built by the server from structured data,
 * never model text. Same "attention" styling as the import approval card.
 */
export default function RuleProposalCard({
  proposalId,
  preview,
  onDone,
}: {
  proposalId: string;
  preview: RulePreview;
  onDone?: (outcome: "approved" | "rejected") => void;
}) {
  const router = useRouter();
  const [state, setState] = useState<"pending" | "busy" | "approved" | "rejected">("pending");
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setState("busy");
    setError(null);
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
  }

  return (
    <section
      aria-label={`Rule for ${preview.merchant}`}
      className="rounded-r-lg border-l-2 border-accent bg-accent-soft px-5 py-4"
    >
      <h3 className="text-[15px] font-semibold">
        Always categorise {preview.merchant} as {preview.toCategory}
      </h3>
      <p className="mt-1 text-[13px] text-muted">
        A rule for future imports
        {preview.affected > 0
          ? `, and ${preview.affected} past ${preview.affected === 1 ? "transaction" : "transactions"} updated now:`
          : ". No past transactions need changing."}
      </p>
      {preview.changes.length > 0 && (
        <ul className="tabular mt-2 text-[13px]">
          {preview.changes.map((c) => (
            <li key={c.from}>
              {c.count} × {c.from} → {preview.toCategory}
            </li>
          ))}
        </ul>
      )}
      {preview.sample.length > 0 && (
        <p className="tabular mt-2 text-[12px] text-muted">
          e.g.{" "}
          {preview.sample.map((r) => `${shortDate(r.txnDate)} ${money(r.amountCents)}`).join(" · ")}
        </p>
      )}
      <div className="mt-3">
        {state === "approved" ? (
          <p role="status" className="text-[13px]">
            Done. The rule is saved{preview.affected ? " and the transactions are updated" : ""}.
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
    </section>
  );
}
