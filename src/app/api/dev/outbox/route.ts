import { getEnv } from "@/env";
import { readDevOutbox } from "@/server/auth/mailer";

// Dev/e2e only: returns the last sign-in code sent to an address. 404 unless
// DEV_MAIL_OUTBOX=1, which env validation refuses on any deployment (production or
// preview). Each code can be read once and expires after 5 minutes.
export async function GET(request: Request) {
  const env = getEnv();
  if (!env.DEV_MAIL_OUTBOX || env.isDeployed) return new Response("Not found", { status: 404 });
  const email = new URL(request.url).searchParams.get("email") ?? "";
  const code = readDevOutbox(email);
  return code ? Response.json({ code }) : new Response("Not found", { status: 404 });
}
