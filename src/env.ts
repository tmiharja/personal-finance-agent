import { z } from "zod";
import { databaseUrl } from "@/db/url";
import { MODEL_IDS } from "@/server/llm/pricing";

const optionalUrl = z.url().optional();
const optionalString = z.string().min(1).optional();
const flag = z
  .enum(["0", "1", "true", "false"])
  .default("0")
  .transform((v) => v === "1" || v === "true");

const rawSchema = z.object({
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  // Set to "1" on every Vercel deployment (production and preview).
  VERCEL: z.string().optional(),

  DATABASE_URL: optionalUrl,
  // Names from connecting Neon with the prefix NEON (see src/db/url.ts).
  NEON_URL: optionalUrl,
  NEON_DATABASE_URL: optionalUrl,

  // Better Auth
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters")
    .optional(),
  BETTER_AUTH_URL: optionalUrl,

  // Envelope encryption: base64 of 32 random bytes. MASTER_KEY_PREVIOUS keeps old
  // user keys readable during a rotation.
  MASTER_KEY: optionalString,
  MASTER_KEY_ID: z.coerce.number().int().min(1).max(999).default(1),
  MASTER_KEY_PREVIOUS: optionalString,

  // Sign-in email (one-time codes)
  RESEND_API_KEY: optionalString,
  EMAIL_FROM: optionalString,

  // Vercel Cron authenticates with "Authorization: Bearer $CRON_SECRET".
  CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters").optional(),

  // Dev/e2e only: keep sent one-time codes in memory, readable at /api/dev/outbox.
  DEV_MAIL_OUTBOX: flag,

  // Claude. Without a key, categorisation falls back to rules + the merchant map
  // and Ask is unavailable (PRD OPS-2: degrade, don't fail).
  ANTHROPIC_API_KEY: optionalString,
  // Per-route models; only priced models are accepted (src/server/llm/pricing.ts).
  MODEL_CATEGORISE: z.enum(MODEL_IDS).default("claude-haiku-4-5"),
  MODEL_ASK: z.enum(MODEL_IDS).default("claude-sonnet-5-5"),
  // Guardrails (PRD §7.3), in USD and questions.
  LLM_GLOBAL_MONTHLY_USD: z.coerce.number().positive().default(40),
  LLM_USER_MONTHLY_USD: z.coerce.number().positive().default(3),
  ASK_DAILY_LIMIT: z.coerce.number().int().positive().default(60),
  // "Try the demo", per visitor per day (PRD AUTH-6).
  DEMO_WORKSPACES_PER_DAY: z.coerce.number().int().positive().default(5),
  DEMO_QUESTIONS_PER_DAY: z.coerce.number().int().positive().default(10),
  // Tests/e2e only: deterministic offline responses instead of the API.
  LLM_MOCK: flag,
});

/** Required in production only; dev and tests fall back to local defaults. Values are the names to set. */
const PRODUCTION_REQUIRED = {
  DATABASE_URL: "DATABASE_URL (or NEON_URL, from connecting Neon with the prefix NEON)",
  BETTER_AUTH_SECRET: "BETTER_AUTH_SECRET",
  BETTER_AUTH_URL: "BETTER_AUTH_URL",
  MASTER_KEY: "MASTER_KEY",
  RESEND_API_KEY: "RESEND_API_KEY",
  EMAIL_FROM: "EMAIL_FROM",
  CRON_SECRET: "CRON_SECRET",
} as const;

const envSchema = rawSchema
  .transform(({ DATABASE_URL, NEON_URL, NEON_DATABASE_URL, ...rest }) => ({
    ...rest,
    DATABASE_URL: databaseUrl({ NEON_URL, NEON_DATABASE_URL, DATABASE_URL }),
    isProduction: rest.VERCEL_ENV === "production",
    /** Any deployed environment (production or preview): dev-only features are off. */
    isDeployed:
      rest.VERCEL === "1" || rest.VERCEL_ENV === "production" || rest.VERCEL_ENV === "preview",
  }))
  .superRefine((env, ctx) => {
    // The outbox exposes sign-in codes, so it is refused on every deployment,
    // previews included, not only in production.
    if (env.isDeployed && env.DEV_MAIL_OUTBOX) {
      ctx.addIssue({
        code: "custom",
        path: ["DEV_MAIL_OUTBOX"],
        message: "DEV_MAIL_OUTBOX must not be enabled on a deployment (production or preview)",
      });
    }
    // Mock answers on a deployment would look like real figures.
    if (env.isDeployed && env.LLM_MOCK) {
      ctx.addIssue({
        code: "custom",
        path: ["LLM_MOCK"],
        message: "LLM_MOCK must not be enabled on a deployment (production or preview)",
      });
    }
    if (!env.isProduction) return;
    for (const [key, name] of Object.entries(PRODUCTION_REQUIRED)) {
      if (!env[key as keyof typeof PRODUCTION_REQUIRED]) {
        ctx.addIssue({ code: "custom", path: [], message: `${name} is required in production` });
      }
    }
  });

export type Env = z.output<typeof envSchema>;

/**
 * Validates an environment record. Throws with every problem listed (names only,
 * never values), so a misconfigured deployment fails fast and legibly.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  // Treat empty strings (common in .env files) as unset.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `  - ${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${problems.join("\n")}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** Server-only accessor. Parsed lazily so `next build` doesn't need runtime secrets. */
export function getEnv(): Env {
  if (typeof window !== "undefined") {
    throw new Error("getEnv() must only be called on the server");
  }
  cached ??= parseEnv(process.env);
  return cached;
}
