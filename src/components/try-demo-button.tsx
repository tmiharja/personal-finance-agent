"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

const MESSAGES: Record<string, string> = {
  demo_limit: "You've opened the demo 5 times today. Try again tomorrow.",
  bad_origin: "Please open the demo from this site.",
};

/** PRD AUTH-6: a no-signup workspace with fictional data. */
export default function TryDemoButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/demo", { method: "POST" });
    if (res.ok) {
      window.location.assign("/app");
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setError(MESSAGES[body.error ?? ""] ?? "The demo couldn't start. Try again in a moment.");
    setBusy(false);
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <Button variant="secondary" onClick={start} disabled={busy}>
        {busy ? "Preparing the demo…" : "Try the demo"}
      </Button>
      {error && (
        <span role="alert" className="text-[13px] text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
