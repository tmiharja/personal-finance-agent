import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/session";
import SignInForm from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getSessionUser()) redirect("/app");
  return (
    <main id="main" className="page-col flex-1 pt-36 pb-[72px]">
      <h1 className="text-[30px] font-medium tracking-tight">Sign in</h1>
      <p className="mt-3 text-[15px] text-muted">
        No password. We email you a 6-digit code, or use a passkey on this device. New here? The
        same steps create your account.
      </p>
      <SignInForm />
    </main>
  );
}
