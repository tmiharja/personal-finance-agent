"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export default function AddPasskey() {
  const [status, setStatus] = useState<"idle" | "added" | "failed">("idle");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-[15px]">Passkey</p>
        <p className="text-[13px] text-muted">
          Sign in with your device’s fingerprint, face or PIN.
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          const res = await authClient.passkey.addPasskey();
          setStatus(res?.error ? "failed" : "added");
        }}
      >
        Add a passkey
      </Button>
      {status !== "idle" && (
        <p
          role="status"
          className={`w-full text-[13px] ${status === "added" ? "text-accent" : "text-danger"}`}
        >
          {status === "added" ? "Passkey added." : "The passkey wasn't added. You can try again."}
        </p>
      )}
    </div>
  );
}
