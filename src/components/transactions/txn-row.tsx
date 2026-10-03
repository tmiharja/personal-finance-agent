"use client";

import { FIXED_KINDS, TRANSFER_MERCHANTS } from "@/lib/kinds";
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
  income: "Money in",
  transfer: "Transfer",
};
const FIXED = new Set<string>(FIXED_KINDS);
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

  async function apply(scope: "one" | "merchant", confirm?: CategoryOption) {
    const target = confirm ?? choice;
    if (!target) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/transactions/${row.id}/category`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categoryId: target.id, scope }),
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

  // PayNow/FAST transfers can be confirmed as your own money moving (Transfers);
  // purchases can't. Each transfer is its own case, so there's no "all from" rule.
  const personTransfer = TRANSFER_MERCHANTS.has(row.merchantName ?? "");
  const choosable = categories.filter(
    (c) => c.kind !== "system" && (c.kind !== "transfer" || personTransfer),
  );
  // A flagged row whose suggested category is right can be confirmed as is.
  const current = choosable.find((c) => c.id === row.categoryId) ?? null;

  return (
    <>
      <tr className="border-t border-rule align-top">
        <td className="py-3 pr-2 text-[13px] whitespace-nowrap text-muted sm:pr-3 sm:text-[15px]">
          {shortDate(row.txnDate)}
        </td>
        <td className="py-3 pr-2 sm:pr-3">
          <span className="block break-words">{row.merchantName ?? row.descriptor}</span>
          {KIND_LABEL[row.kind] && (
            <span className="mt-0.5 inline-block rounded-full border border-rule px-2 text-[11px] text-muted sm:hidden">
              {KIND_LABEL[row.kind]}
            </span>
          )}
          <span className="hidden text-[12px] break-words text-muted sm:block">
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
          {FIXED.has(row.kind) || row.paired ? (
            <span className="text-muted">
              {row.categoryName}
              {row.paired && <span className="block text-[12px]">matched across accounts</span>}
            </span>
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
                  "max-w-[112px] rounded-md border border-rule bg-background px-1.5 py-1 sm:max-w-[150px]",
                  row.review && !choice && "border-warn",
                )}
              >
                {/* Uncategorised isn't a choice, but must still show as the current value. */}
                {!choosable.some((c) => c.id === row.categoryId) && (
                  <option value={row.categoryId ?? ""}>{row.categoryName}</option>
                )}
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
              {row.review && !choice && current && (
                <button
                  type="button"
                  onClick={() => apply("one", current)}
                  disabled={busy}
                  className="link ml-1 text-[12px] whitespace-nowrap"
                  aria-label={`Confirm ${current.name} for ${merchant} on ${shortDate(row.txnDate)}`}
                >
                  Looks right
                </button>
              )}
              {error && !choice && (
                <span role="alert" className="ml-1 text-[12px] text-danger">
                  {error}
                </span>
              )}
            </label>
          )}
        </td>
        <td className="py-3 text-right whitespace-nowrap">
          <span className={cn(row.amountCents < 0 && "text-accent")}>
            {row.amountCents < 0 && (row.kind === "income" || row.kind === "transfer")
              ? money(-row.amountCents, { signed: true })
              : money(row.amountCents)}
          </span>
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
                  {!personTransfer && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => apply("merchant")}
                      disabled={busy || !row.merchantName}
                    >
                      All {merchant} transactions, past and future…
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setChoice(null)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
                <p className="mt-2 text-muted">
                  {personTransfer
                    ? choice!.kind === "transfer"
                      ? "Marks this as money moving between your own accounts: not spending or income."
                      : "Applies to this transfer only."
                    : "“All” creates a rule. You’ll see exactly what changes before approving it."}
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
