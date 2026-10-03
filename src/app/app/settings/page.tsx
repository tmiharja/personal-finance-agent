import type { Metadata } from "next";
import Link from "next/link";
import PageTitle from "@/components/app/page-title";
import SignOutButton from "@/components/app/sign-out-button";
import { requireUser } from "@/server/auth/session";
import AddPasskey from "./add-passkey";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requireUser();
  return (
    <>
      <PageTitle title="Settings" />
      <section className="max-w-[560px]">
        <h2 className="text-[17px] font-semibold">Account</h2>
        {user.isDemo ? (
          <p className="mt-4 border-t border-rule py-4 text-[15px] text-muted">
            This is a demo workspace with fictional data. It&rsquo;s deleted 24 hours after you
            opened it. Sign out to leave it now.
          </p>
        ) : (
          <>
            <div className="mt-4 flex justify-between border-t border-rule py-4 text-[15px]">
              <span className="text-muted">Signed in as</span>
              <span>{user.email}</span>
            </div>
            <div className="border-t border-rule py-4">
              <AddPasskey />
            </div>
          </>
        )}
        <div className="border-t border-rule py-4">
          <SignOutButton className="link text-[15px]" />
        </div>
      </section>
      <section className="mt-12 max-w-[560px]">
        <h2 className="text-[17px] font-semibold">More</h2>
        <ul className="mt-4">
          {[
            ["/app/subscriptions", "Subscriptions"],
            ["/app/alerts", "Alerts"],
            ["/app/import", "Import statements"],
          ].map(([href, label]) => (
            <li key={href} className="border-t border-rule py-3 text-[15px]">
              <Link href={href!} className="link">
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section className="mt-12 max-w-[560px]">
        <h2 className="text-[17px] font-semibold">Your data</h2>
        <p className="mt-3 border-t border-rule py-4 text-[15px] text-muted">
          Export and “Delete my account and all data” arrive with the approval engine (Phase 3).
          Both will ask you to sign in again first.
        </p>
      </section>
    </>
  );
}
