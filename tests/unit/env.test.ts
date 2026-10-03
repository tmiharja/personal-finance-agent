import { describe, expect, it } from "vitest";
import { parseEnv } from "@/env";
import { masterKeysFromEnv } from "@/server/crypto/envelope";

const prodBase = {
  VERCEL_ENV: "production",
  DATABASE_URL: "postgres://u@db.example.com/x",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "https://finance.example.com",
  MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "Finance Agent <no-reply@example.com>",
};

describe("environment validation", () => {
  it("accepts a complete production config", () => {
    expect(parseEnv(prodBase).isProduction).toBe(true);
  });

  it("lists every missing production variable by name, never by value", () => {
    expect(() => parseEnv({ VERCEL_ENV: "production" })).toThrow(
      /DATABASE_URL[\s\S]*BETTER_AUTH_SECRET[\s\S]*MASTER_KEY/,
    );
  });

  it("refuses the dev mail outbox in production", () => {
    expect(() => parseEnv({ ...prodBase, DEV_MAIL_OUTBOX: "1" })).toThrow(/DEV_MAIL_OUTBOX/);
  });

  it("the master keys used by the test configs are valid", () => {
    for (const key of [process.env.MASTER_KEY]) {
      expect(() => masterKeysFromEnv({ MASTER_KEY: key, MASTER_KEY_ID: 1 })).not.toThrow();
    }
  });
});
