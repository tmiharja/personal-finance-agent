"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import SignOutButton from "@/components/app/sign-out-button";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

/**
 * "Delete my account and all data": everything you own is deleted at once
 * (statements, transactions, rules, history, keys). Needs a sign-in in the
 * last 10 minutes and typing "delete" to confirm.
 */
export default function DeleteAccount() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"reauth" | "failed" | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await authClient.deleteUser();
      if (err) {
        setError(err.code === "SESSION_EXPIRED" ? "reauth" : "failed");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open)
    return (
      <button type="button" className="link text-[15px] text-danger!" onClick={() => setOpen(true)}>
        Delete my account and all data…
      </button>
    );
  return (
    <div className="rounded-lg border border-danger/40 px-4 py-4 text-[15px]">
      <p>
        This deletes your cards and bank accounts, transactions, rules, budgets, bills, alerts,
        Activity history and encryption key, straight away. It can&rsquo;t be undone.
      </p>
      <label className="mt-3 flex flex-col gap-1 text-[13px] text-muted">
        Type &ldquo;delete&rdquo; to confirm
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="w-40 rounded-md border border-rule bg-background px-2 py-1 text-[15px]"
          autoComplete="off"
        />
      </label>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="danger"
          disabled={busy || typed.trim().toLowerCase() !== "delete"}
          onClick={remove}
        >
          {busy ? "Deleting…" : "Delete everything"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {error === "reauth" && (
        <p role="alert" className="mt-2 text-[13px] text-warn">
          For your security, this needs a sign-in from the last 10 minutes.{" "}
          <SignOutButton className="link text-[13px]" /> and sign in again.
        </p>
      )}
      {error === "failed" && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          Something went wrong. Nothing was deleted.
        </p>
      )}
    </div>
  );
}
