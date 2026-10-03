"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ProposalCard from "@/components/proposals/proposal-card";
import { proposalErrorMessage } from "@/components/proposals/messages";
import { Button } from "@/components/ui/button";
import type { ActionPreview } from "@/server/actions/engine";

export type PendingItem = {
  id: string;
  proposer: string;
  preview: ActionPreview;
};

/**
 * Suggested changes waiting for you, with batch approval (ACT-5): tick some
 * or all, approve them together. Each is applied, or refused, on its own.
 */
export default function PendingList({
  items,
  children,
}: {
  items: PendingItem[];
  /** Shown when nothing is waiting. */
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const all = items.length > 0 && items.every((i) => selected.has(i.id));

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  async function approveSelected() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/proposals/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        results?: { id: string; ok: boolean; code?: string }[];
      };
      if (!res.ok || !body.results) {
        setMessage({ text: proposalErrorMessage(body.error ?? ""), error: true });
        return;
      }
      const failed = body.results.filter((r) => !r.ok);
      const done = body.results.length - failed.length;
      setMessage({
        text:
          failed.length === 0
            ? `Approved ${done}. You can undo each from the history below.`
            : `Approved ${done}; ${failed.length} not applied: ${proposalErrorMessage(failed[0]!.code ?? "")}`,
        error: failed.length > 0,
      });
      setSelected(new Set());
      router.refresh();
    } catch {
      setMessage({ text: proposalErrorMessage(""), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {items.length > 1 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px]">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={all}
              onChange={(e) =>
                setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())
              }
              className="size-4"
            />
            Select all
          </label>
          <Button size="sm" onClick={approveSelected} disabled={busy || selected.size === 0}>
            {busy ? "Approving…" : `Approve selected (${selected.size})`}
          </Button>
        </div>
      )}
      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={message.error ? "mt-2 text-[13px] text-danger" : "mt-2 text-[13px]"}
        >
          {message.text}
        </p>
      )}
      {children}
      {items.length > 0 && (
        <ul className="mt-3">
          {items.map((p) => (
            <li key={p.id} className="border-t border-rule py-4">
              <ProposalCard
                proposalId={p.id}
                preview={p.preview}
                from={
                  p.proposer === "agent" ? "assistant" : p.proposer === "user" ? undefined : "app"
                }
                selected={selected.has(p.id)}
                onSelect={items.length > 1 ? (on) => toggle(p.id, on) : undefined}
                onDone={() => toggle(p.id, false)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
