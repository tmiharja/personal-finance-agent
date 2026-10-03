import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { emailOTP } from "better-auth/plugins/email-otp";
import { after } from "next/server";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { getEnv } from "@/env";
import { site } from "@/lib/site";
import { logEvent } from "@/server/log";
import { sendSignInCode } from "./mailer";

function createAuth() {
  const env = getEnv();
  const baseURL = env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const { hostname, origin } = new URL(baseURL);

  return betterAuth({
    appName: site.name,
    baseURL,
    secret:
      env.BETTER_AUTH_SECRET ??
      (env.isProduction ? undefined : "dev-only-secret-not-for-production-use"),
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        passkey: schema.passkey,
        rateLimit: schema.rateLimit,
      },
    }),
    // Better Auth's default logger prints failing rows (emails included). Route it
    // through the safe logger: level, error class and Postgres/HTTP code only.
    logger: {
      level: "warn",
      log: (level, _message, ...args) => {
        const err = args.find((a): a is Error => a instanceof Error) as
          (Error & { code?: unknown }) | undefined;
        logEvent("auth.log", {
          level,
          errorClass: err?.name,
          code: err?.code ? String(err.code) : undefined,
        });
      },
    },
    // Passwordless only: email one-time codes and passkeys.
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // absolute 7 days
      updateAge: 60 * 60 * 24,
      // Sensitive actions (export, delete, large approvals) require a session this fresh.
      freshAge: 60 * 10,
    },
    user: { deleteUser: { enabled: true } },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    advanced: {
      // Don't store sign-in IP addresses (PRD §7.1 data minimisation).
      ipAddress: { disableIpTracking: true },
      useSecureCookies: env.isProduction,
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 5 * 60,
        allowedAttempts: 3,
        storeOTP: "hashed",
        // Sent after the response (Next's after()), so response time doesn't reveal
        // whether the email exists, while serverless still waits for delivery.
        sendVerificationOTP: async ({ email, otp }) => {
          try {
            after(() => sendSignInCode(email, otp));
          } catch {
            // Outside a request scope (scripts, tests): send directly.
            await sendSignInCode(email, otp);
          }
        },
      }),
      passkey({ rpID: hostname, rpName: site.name, origin }),
      nextCookies(), // keep last
    ],
  });
}

let cached: ReturnType<typeof createAuth> | undefined;

/** Created lazily so `next build` doesn't need a database or secrets. */
export function getAuth() {
  cached ??= createAuth();
  return cached;
}
