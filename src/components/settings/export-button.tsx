"use client";

import { useState } from "react";
import SignOutButton from "@/components/app/sign-out-button";
import { proposalErrorMessage } from "@/components/proposals/messages";

/**
 * Downloads transactions as CSV (export_csv). Recorded in Activity; asks you to
 * sign in again when your sign-in is more than 10 minutes old (AUTH-3).
 */
export default function ExportButton({
  filter = {},
  label = "Export CSV",
}: {
  filter?: Record<string, string | undefined>;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);

  async function download() {
    setBusy(true);
    setError(null);
    setReauth(false);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined)),
        ),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === "reauth_required") setReauth(true);
        else setError(proposalErrorMessage(body.error ?? ""));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "transactions.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(proposalErrorMessage(""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="link text-[13px] disabled:opacity-50"
      >
        {busy ? "Preparing…" : label}
      </button>
      {reauth && (
        <span role="alert" className="max-w-[320px] text-right text-[12px] text-warn">
          For your security, exports need a sign-in from the last 10 minutes.{" "}
          <SignOutButton className="link text-[12px]" /> and sign in again.
        </span>
      )}
      {error && (
        <span role="alert" className="text-[12px] text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
