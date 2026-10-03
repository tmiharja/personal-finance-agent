"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import RuleProposalCard from "@/components/proposals/rule-proposal-card";
import { proposalErrorMessage } from "@/components/proposals/messages";
import { Button } from "@/components/ui/button";
import { money, shortDate, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RulePreview } from "@/server/actions/rules";
import type { CategoryOption, TxnRow as Row } from "@/server/finance/transactions";

const KIND_LABEL: Record<string, string> = {
  card_payment: "Card payment",
  refund: "Refund",
  fee: "Fee",
  cashback: "Cashback",
};
const FIXED = new Set(["card_payment", "fee", "cashback"]);
const COLS = 5;

/**
 * One transaction, with inline recategorise (PRD CAT-5): pick a category, then
 * "this one only" (applied now) or "all from this merchant" (a rule you approve).
 */
export default function TxnRow({ row, categories }: { row: Row; categories: CategoryOption[] }) {
  const router = useRouter();
  const [choice, setChoice] = useState<CategoryOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{ id: string; preview: RulePreview } | null>(null);
  const merchant = row.merchantName ?? "this merchant";

  async function apply(scope: "one" | "merchant") {
    if (!choice) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/transactions/${row.id}/category`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categoryId: choice.id, scope }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      proposalId?: string;
      preview?: RulePreview;
    };
    setBusy(false);
    if (!res.ok) {
      setError(proposalErrorMessage(body.error ?? ""));
      return;
    }
    if (scope === "merchant" && body.proposalId && body.preview) {
      setProposal({ id: body.proposalId, preview: body.preview });
      router.refresh(); // header approvals badge
    } else {
      setChoice(null);
      router.refresh();
    }
  }

  const choosable = categories.filter((c) => c.kind !== "transfer" && c.kind !== "system");

  return (
    <>
      <tr className="border-t border-rule align-top">
        <td className="py-3 pr-3 whitespace-nowrap text-muted">{shortDate(row.txnDate)}</td>
        <td className="py-3 pr-3">
          <span className="block">{row.merchantName ?? row.descriptor}</span>
          <span className="block text-[12px] break-all text-muted">
            {row.descriptor}
            {KIND_LABEL[row.kind] && (
              <span className="ml-2 rounded-full border border-rule px-2 text-[11px]">
                {KIND_LABEL[row.kind]}
              </span>
            )}
          </span>
        </td>
        <td className="hidden py-3 pr-3 text-[13px] text-muted md:table-cell">
          {titleCase(row.card)}
        </td>
        <td className="py-3 pr-3 text-[13px]">
          {FIXED.has(row.kind) ? (
            <span className="text-muted">{row.categoryName}</span>
          ) : (
            <label className="flex items-center gap-1">
              <span className="sr-only">
                Category for {merchant} on {shortDate(row.txnDate)}
              </span>
              <select
                value={choice?.id ?? row.categoryId ?? ""}
                onChange={(e) => {
                  const next = categories.find((c) => c.id === e.target.value) ?? null;
                  setProposal(null);
                  setError(null);
                  setChoice(next && next.id !== row.categoryId ? next : null);
                }}
                className={cn(
                  "max-w-[150px] rounded-md border border-rule bg-background px-1.5 py-1",
                  row.review && !choice && "border-warn",
                )}
              >
                {!row.categoryId && <option value="">Uncategorised</option>}
                {choosable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {row.review && !choice && (
                <span className="text-warn" title="Needs a look: low confidence or uncategorised">
                  ?
                </span>
              )}
            </label>
          )}
        </td>
        <td className="py-3 text-right whitespace-nowrap">
          <span className={cn(row.amountCents < 0 && "text-accent")}>{money(row.amountCents)}</span>
          {row.fx && (
            <span className="block text-[12px] text-muted">
              {row.fx.currency ?? "FX"} {Number(row.fx.amount).toLocaleString("en-SG")}
            </span>
          )}
        </td>
      </tr>
      {(choice || proposal) && (
        <tr>
          <td colSpan={COLS} className="pb-4">
            {proposal ? (
              <RuleProposalCard
                proposalId={proposal.id}
                preview={proposal.preview}
                onDone={() => setChoice(null)}
              />
            ) : (
              <div className="rounded-lg border border-rule px-4 py-3 text-[13px]">
                <p>
                  Change to <strong className="font-medium">{choice!.name}</strong> for:
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => apply("one")} disabled={busy}>
                    This transaction only
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => apply("merchant")}
                    disabled={busy || !row.merchantName}
                  >
                    All {merchant} transactions, past and future…
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setChoice(null)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
                <p className="mt-2 text-muted">
                  &ldquo;All&rdquo; creates a rule. You&rsquo;ll see exactly what changes before
                  approving it.
                </p>
                {error && (
                  <p role="alert" className="mt-2 text-danger">
                    {error}
                  </p>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
