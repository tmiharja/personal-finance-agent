"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { longDate, money, shortDate, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { errorMessage, type CommitResult, type ImportPreview } from "./types";

const CATEGORY_WARNING: Record<string, string> = {
  categoriser_unavailable: "AI categorisation is off, so unknown merchants are Uncategorised",
  categoriser_paused: "AI categorisation is paused (monthly limit reached)",
  categoriser_failed: "AI categorisation didn’t respond; unknown merchants are Uncategorised",
  categoriser_blocked: "some merchants weren’t sent for AI categorisation",
  categoriser_refused: "some merchants couldn’t be categorised",
};

const KIND_LABEL: Record<string, string> = {
  card_payment: "Card payment",
  refund: "Refund",
  fee: "Fee",
  cashback: "Cashback",
  income: "Income",
  transfer: "Transfer",
};

/** Bank accounts read as money in (+) and out; cards keep their statement signs. */
const rowAmount = (cents: number, deposit: boolean) =>
  deposit && cents < 0 ? money(-cents, { signed: true }) : money(cents);

/**
 * The commit_import proposal (PRD ACT-4): a deterministic, server-built preview
 * with Approve / Discard. Styled as the app's one "attention" surface (§8).
 */
export default function PreviewCard({
  preview,
  onDone,
}: {
  preview: ImportPreview;
  onDone?: (outcome: "committed" | "discarded") => void;
}) {
  const router = useRouter();
  const { summary } = preview;
  const [state, setState] = useState<"pending" | "busy" | "committed" | "discarded">(
    preview.status === "committed"
      ? "committed"
      : preview.status === "previewed"
        ? "pending"
        : "discarded",
  );
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acceptMismatch, setAcceptMismatch] = useState(false);
  const deposit = summary.kind === "deposit";
  const unit = deposit ? ["account", "accounts"] : ["card", "cards"];
  const total = summary.cards.reduce((s, c) => s + c.counts.rows, 0);
  const fresh = summary.cards.reduce((s, c) => s + c.counts.newRows, 0);

  async function decide(decision: "approve" | "reject") {
    setState("busy");
    setError(null);
    const res = await fetch(`/api/proposals/${preview.proposalId}/${decision}`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as CommitResult & { error?: string };
    if (!res.ok) {
      setError(errorMessage(body.error ?? ""));
      setState("pending");
      return;
    }
    if (decision === "approve") setResult(body);
    setState(decision === "approve" ? "committed" : "discarded");
    onDone?.(decision === "approve" ? "committed" : "discarded");
    router.refresh();
  }

  return (
    <section
      aria-label={`${summary.bank} statement ${longDate(summary.statementDate)}`}
      className="rounded-r-lg border-l-2 border-accent bg-accent-soft px-5 py-5 sm:px-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="text-[17px] font-semibold">
          {summary.bank} {deposit ? "bank-account" : "credit-card"} statement ·{" "}
          {longDate(summary.statementDate)}
        </h2>
        <span className="text-[13px] text-muted">
          {summary.dueDate && <>Due {longDate(summary.dueDate)}</>}
          {summary.minimumPaymentCents !== null && (
            <> · minimum {money(summary.minimumPaymentCents)}</>
          )}
        </span>
      </div>

      <p className="mt-2 text-[15px]">
        {total} transactions on {summary.cards.length}{" "}
        {summary.cards.length === 1 ? unit[0] : unit[1]}
        {fresh !== total && (
          <>
            {" "}
            · {fresh} new, {total - fresh} already imported (skipped)
          </>
        )}
        {summary.statementTotalCents !== null && (
          <> · statement total {money(summary.statementTotalCents)}</>
        )}
      </p>

      {summary.categories && (
        <p className="mt-1 text-[13px] text-muted">
          Categorised automatically
          {summary.categories.toReview > 0
            ? ` · ${summary.categories.toReview} to review after import (marked ?)`
            : " · nothing to review"}
          {CATEGORY_WARNING[summary.warnings.find((w) => w in CATEGORY_WARNING) ?? ""] && (
            <> · {CATEGORY_WARNING[summary.warnings.find((w) => w in CATEGORY_WARNING)!]}</>
          )}
        </p>
      )}

      {summary.pairing &&
        summary.pairing.cardPayments +
          summary.pairing.transfers +
          summary.pairing.linkedCardPayments >
          0 && (
          <p className="mt-1 text-[13px] text-muted">
            Matched with your other accounts:{" "}
            {[
              summary.pairing.cardPayments + summary.pairing.linkedCardPayments > 0 &&
                `${summary.pairing.cardPayments + summary.pairing.linkedCardPayments} card ${
                  summary.pairing.cardPayments + summary.pairing.linkedCardPayments === 1
                    ? "payment"
                    : "payments"
                }`,
              summary.pairing.transfers > 0 &&
                `${summary.pairing.transfers} ${
                  summary.pairing.transfers === 1 ? "transfer" : "transfers"
                } between your accounts`,
            ]
              .filter(Boolean)
              .join(" · ")}{" "}
            (not counted as spending or income)
          </p>
        )}

      {!summary.allReconciled && (
        <p role="alert" className="mt-3 rounded-lg bg-warn-soft px-4 py-3 text-[15px] text-warn">
          {summary.cards.some((c) => c.reconciled === false)
            ? deposit
              ? "Doesn’t reconcile: some accounts’ transactions don’t add up to their closing balance. Check the accounts marked below before importing."
              : "Doesn’t reconcile: some cards don’t add up to their printed totals. Check the cards marked below before importing."
            : summary.cards.some((c) => c.reconciled === null)
              ? "Couldn’t check: this file has no opening and closing balance, so the transactions couldn’t be reconciled. Compare a few rows with your bank before importing."
              : summary.totalsMatch === false
                ? "Doesn’t reconcile: the cards don’t add up to the statement’s printed total."
                : "Couldn’t fully check: the statement’s printed total wasn’t found, so the cards couldn’t be cross-checked against it."}
        </p>
      )}

      {summary.cards.map((card, i) => {
        const rows = preview.rows[i] ?? [];
        return (
          <div
            key={`${card.productName}-${card.ordinal}`}
            className="mt-5 border-t border-rule pt-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[15px] font-medium">
                {titleCase(card.productName)}
                {card.ordinal > 1 && ` (${card.ordinal})`}
                {card.isNewCard && (
                  <span className="ml-2 text-[12px] font-normal text-muted">new {unit[0]}</span>
                )}
              </h3>
              <span
                className={cn(
                  "text-[13px]",
                  card.reconciled === true ? "text-accent" : "text-warn",
                )}
              >
                {card.reconciled === true
                  ? "✓ Reconciled"
                  : card.reconciled === null
                    ? "No balances to check"
                    : !card.differenceCents
                      ? "✗ Total not found"
                      : `✗ Off by ${money(Math.abs(card.differenceCents))}`}
              </span>
            </div>
            <p className="tabular mt-1 text-[13px] text-muted">
              {deposit ? (
                <>
                  {card.previousBalanceCents !== null &&
                    `Opening ${money(-card.previousBalanceCents)} · `}
                  {card.totalCents !== null && `closing ${money(-card.totalCents)} · `}
                </>
              ) : (
                card.previousBalanceCents !== null &&
                card.totalCents !== null &&
                `Previous ${money(card.previousBalanceCents)} · new balance ${money(card.totalCents)} · `
              )}
              {card.counts.rows} rows
              {(card.counts.income ?? 0) > 0 &&
                ` · ${card.counts.income} income (${money(card.incomeCents ?? 0)})`}
              {(card.counts.transfers ?? 0) > 0 && ` · ${card.counts.transfers} transfer`}
              {card.counts.cardPayments > 0 && ` · ${card.counts.cardPayments} card payment`}
              {card.counts.refunds > 0 && ` · ${card.counts.refunds} refund`}
              {card.counts.fees > 0 && ` · ${card.counts.fees} fee`}
              {card.counts.foreignCurrency > 0 &&
                ` · ${card.counts.foreignCurrency} foreign currency`}
              {card.counts.duplicates > 0 && ` · ${card.counts.duplicates} duplicate`}
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer text-[13px] text-accent">
                Show transactions
              </summary>
              <table className="tabular mt-2 w-full text-[13px]">
                <tbody>
                  {rows.map((r, j) => (
                    <tr
                      key={j}
                      className={cn(
                        "border-t border-rule",
                        r.duplicate && "text-muted line-through",
                      )}
                    >
                      <td className="py-1.5 pr-3 whitespace-nowrap text-muted">
                        {shortDate(r.txnDate)}
                      </td>
                      <td className="py-1.5 pr-3">
                        <span>{r.descriptor}</span>
                        {KIND_LABEL[r.kind] && (
                          <span className="ml-2 rounded-full border border-rule px-2 text-[11px] text-muted">
                            {KIND_LABEL[r.kind]}
                          </span>
                        )}
                        {r.fx && (
                          <span className="ml-2 text-[11px] text-muted">
                            {r.fx.currency ?? "FX"} {Number(r.fx.amount).toLocaleString("en-SG")}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-[12px] whitespace-nowrap text-muted">
                        {r.categoryName && r.kind !== "card_payment" && r.kind !== "transfer" && (
                          <span
                            title={r.review ? "Low confidence: review after import" : undefined}
                          >
                            {r.categoryName}
                            {r.review && <span className="ml-1 text-warn">?</span>}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-right whitespace-nowrap">
                        {rowAmount(r.amountCents, deposit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        );
      })}

      <div className="mt-6 border-t border-rule pt-5">
        {state === "committed" ? (
          <p role="status" className="text-[15px]">
            Imported {result ? `${result.inserted} transactions` : "this statement"}
            {result?.paired ? `, ${result.paired} matched with your other accounts` : ""}.{" "}
            <Link href="/app" className="link">
              View overview
            </Link>
          </p>
        ) : state === "discarded" ? (
          <p role="status" className="text-[15px] text-muted">
            {preview.status === "expired"
              ? "This preview expired. Upload the file again."
              : "Discarded. Nothing was imported."}
          </p>
        ) : (
          <>
            {!summary.allReconciled && (
              <label className="mb-4 flex items-start gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={acceptMismatch}
                  onChange={(e) => setAcceptMismatch(e.target.checked)}
                  className="mt-0.5"
                />
                Import anyway. I&rsquo;ve checked the differences.
              </label>
            )}
            <div className="flex flex-wrap gap-3">
              <Button
                onClick={() => decide("approve")}
                disabled={
                  state === "busy" || (!summary.allReconciled && !acceptMismatch) || fresh === 0
                }
              >
                {state === "busy"
                  ? "Working…"
                  : fresh === 0
                    ? "Nothing new to import"
                    : `Approve import (${fresh})`}
              </Button>
              <Button
                variant="secondary"
                onClick={() => decide("reject")}
                disabled={state === "busy"}
              >
                Discard
              </Button>
            </div>
            <p className="mt-3 text-[13px] text-muted">
              Nothing is saved until you approve. Card numbers, names and addresses were removed;
              this preview expires in 24 hours.
            </p>
          </>
        )}
        {error && (
          <p
            role="alert"
            className="mt-4 rounded-lg bg-danger-soft px-4 py-3 text-[15px] text-danger"
          >
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
