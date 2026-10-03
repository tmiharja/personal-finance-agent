"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { parseSgd, postAction } from "./post-action";

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const field = "rounded-md border border-rule bg-background px-2 py-1 text-[15px]";

/**
 * Add a recurring bill the statements don't show (DET-6), or change one you
 * added. Applied through the action engine, so it's undoable from Activity.
 */
export default function BillForm({
  bill,
  onDone,
}: {
  bill?: { id: string; payee: string; dueDay: number | null; expectedAmountCents: number | null };
  onDone?: () => void;
}) {
  const router = useRouter();
  const [payee, setPayee] = useState(bill?.payee ?? "");
  const [day, setDay] = useState(String(bill?.dueDay ?? 1));
  const [amount, setAmount] = useState(
    bill?.expectedAmountCents == null ? "" : (bill.expectedAmountCents / 100).toFixed(2),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = bill ? `bill-${bill.id}` : "new-bill";

  async function submit() {
    const cents = amount.trim() === "" ? null : parseSgd(amount);
    if (amount.trim() !== "" && cents === null) return setError("Enter an amount like 89.90.");
    if (!bill && payee.trim().length < 2) return setError("Enter who the bill is from.");
    setBusy(true);
    setError(null);
    const err = bill
      ? await postAction("update_bill", {
          billId: bill.id,
          dueDay: Number(day),
          expectedAmountCents: cents,
        })
      : await postAction("add_bill", {
          payee: payee.trim(),
          dueDay: Number(day),
          expectedAmountCents: cents,
        });
    setBusy(false);
    if (err) return setError(err);
    if (!bill) {
      setPayee("");
      setAmount("");
    }
    onDone?.();
    router.refresh();
  }

  return (
    <form
      aria-label={bill ? `Change the ${bill.payee} bill` : "Add a bill"}
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {!bill && (
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          From
          <input
            id={`${id}-payee`}
            value={payee}
            maxLength={60}
            placeholder="e.g. Sample Gym"
            onChange={(e) => setPayee(e.target.value)}
            className={`${field} w-48`}
          />
        </label>
      )}
      <label className="flex flex-col gap-1 text-[12px] text-muted">
        Due day
        <select value={day} onChange={(e) => setDay(e.target.value)} className={field}>
          {DAYS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[12px] text-muted">
        Usual amount (S$)
        <input
          inputMode="decimal"
          value={amount}
          placeholder="optional"
          onChange={(e) => setAmount(e.target.value)}
          className={`${field} tabular w-28 text-right`}
        />
      </label>
      <Button size="sm" type="submit" disabled={busy}>
        {bill ? "Save" : "Add bill"}
      </Button>
      {bill && onDone && (
        <Button size="sm" variant="ghost" type="button" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      )}
      {error && (
        <p role="alert" className="w-full text-[13px] text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
