"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { postAction } from "./post-action";

/** A merchant rule: change its category (rows it categorised move too) or delete it. */
export default function RuleRow({
  ruleId,
  pattern,
  categoryId,
  categories,
}: {
  ruleId: string;
  pattern: string;
  categoryId: string;
  categories: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(type: "update_rule" | "delete_rule", input: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const err = await postAction(type, input);
    setBusy(false);
    if (err) setError(err);
    else router.refresh();
  }

  return (
    <li className="border-t border-rule py-3">
      <div className="flex flex-wrap items-center gap-3 text-[15px]">
        <span className="min-w-[150px] flex-1">{pattern}</span>
        <label className="flex items-center gap-2">
          <span className="sr-only">Category for the {pattern} rule</span>
          <span aria-hidden className="text-muted">
            →
          </span>
          <select
            value={categoryId}
            disabled={busy}
            onChange={(e) => run("update_rule", { ruleId, categoryId: e.target.value })}
            className="rounded-md border border-rule bg-background px-2 py-1 text-[13px]"
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => run("delete_rule", { ruleId })}
          aria-label={`Delete the ${pattern} rule`}
        >
          Delete
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-[13px] text-danger">
          {error}
        </p>
      )}
    </li>
  );
}
