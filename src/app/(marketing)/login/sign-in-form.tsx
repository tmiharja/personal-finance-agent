"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

type Step = "email" | "code";

const inputClass =
  "mt-2 h-11 w-full rounded-lg border border-rule bg-background px-3 text-[15px] outline-none focus-visible:outline-2 focus-visible:outline-accent";

export default function SignInForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
    setBusy(false);
    if (error)
      return setError("We couldn't send a code. Check the address and try again in a minute.");
    setStep("code");
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.emailOtp({ email, otp: code.trim() });
    setBusy(false);
    if (error)
      return setError("That code didn't work. Codes expire after 5 minutes and allow 3 tries.");
    router.push("/app");
    router.refresh();
  }

  async function passkey() {
    setError(null);
    const res = await authClient.signIn.passkey();
    if (res?.error)
      return setError("Passkey sign-in didn't complete. You can use an email code instead.");
    router.push("/app");
    router.refresh();
  }

  return (
    <div className="mt-10">
      {step === "email" ? (
        <form onSubmit={sendCode}>
          <label htmlFor="email" className="text-[13px] font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email webauthn"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
          <Button type="submit" disabled={busy} className="mt-5 w-full sm:w-auto">
            {busy ? "Sending…" : "Email me a code"}
          </Button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <p className="text-[15px] text-muted">
            We sent a 6-digit code to <span className="text-foreground">{email}</span>.
          </p>
          <label htmlFor="code" className="mt-5 block text-[13px] font-medium">
            Code
          </label>
          <input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className={`${inputClass} tabular tracking-[0.3em]`}
          />
          <div className="mt-5 flex flex-wrap gap-3">
            <Button type="submit" disabled={busy}>
              {busy ? "Checking…" : "Sign in"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setStep("email")}>
              Use a different email
            </Button>
          </div>
        </form>
      )}

      <div className="mt-10 border-t border-rule pt-6">
        <Button type="button" variant="secondary" onClick={passkey}>
          Sign in with a passkey
        </Button>
        <p className="mt-2 text-[13px] text-muted">
          Add a passkey in Settings after your first sign-in.
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-6 rounded-lg bg-danger-soft px-4 py-3 text-[15px] text-danger"
        >
          {error}
        </p>
      )}
    </div>
  );
}
