import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth";

export type SessionUser = { id: string; email: string; name: string; isDemo: boolean };

/** The signed-in user, validated against the database (not just the cookie). */
export async function getSessionUser(): Promise<SessionUser | null> {
  // Read request headers first: it marks the route dynamic before any database work.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    isDemo: (session.user as { isAnonymous?: boolean | null }).isAnonymous === true,
  };
}

/** For server components and actions under /app. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}
