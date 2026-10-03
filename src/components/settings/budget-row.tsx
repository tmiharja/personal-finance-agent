"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { parseSgd, postAction } from "./post-action";

/** One spending category's monthly budget: set, change or remove it. */
export default function BudgetRow({
  categoryId,
  category,
  cents,
}: {
  categoryId: string;
  category: string;
  cents: number | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(cents === null ? "" : (cents / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(amount: number | null) {
    setBusy(true);
    setError(null);
    const err = await postAction("set_budget", { categoryId, monthlyAmountCents: amount });
    setBusy(false);
    if (err) setError(err);
    else {
      setValue(amount === null ? "" : (amount / 100).toFixed(2));
      router.refresh();
    }
  }

  const parsed = parseSgd(value);
  const changed = value.trim() !== "" && parsed !== null && parsed !== cents;
  return (
    <li className="border-t border-rule py-3">
      <form
        className="flex flex-wrap items-center gap-3 text-[15px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed === null) setError("Enter an amount like 450 or 450.00.");
          else void save(parsed);
        }}
      >
        <label htmlFor={`budget-${categoryId}`} className="min-w-[150px] flex-1">
          {category}
        </label>
        <span className="flex items-center gap-1">
          <span className="text-[13px] text-muted">S$</span>
          <input
            id={`budget-${categoryId}`}
            inputMode="decimal"
            value={value}
            placeholder="No budget"
            onChange={(e) => setValue(e.target.value)}
            className="tabular w-28 rounded-md border border-rule bg-background px-2 py-1 text-right"
          />
          <span className="text-[13px] text-muted">a month</span>
        </span>
        <span className="flex gap-2">
          <Button size="sm" type="submit" disabled={busy || !changed}>
            Save
          </Button>
          {cents !== null && (
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => save(null)}
              aria-label={`Remove the ${category} budget`}
            >
              Remove
            </Button>
          )}
        </span>
      </form>
      {error && (
        <p role="alert" className="mt-1 text-[13px] text-danger">
          {error}
        </p>
      )}
    </li>
  );
}
