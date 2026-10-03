import { afterEach, describe, expect, it, vi } from "vitest";

async function loadMailer(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.spyOn(console, "info").mockImplementation(() => {});
  return import("@/server/auth/mailer");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("dev mail outbox", () => {
  it("returns a code once, then forgets it", async () => {
    const m = await loadMailer({ DEV_MAIL_OUTBOX: "1" });
    await m.sendSignInCode("Dev@Example.com", "123123");
    expect(m.readDevOutbox("dev@example.com")).toBe("123123");
    expect(m.readDevOutbox("dev@example.com")).toBeUndefined();
  });

  it("drops codes after 5 minutes", async () => {
    vi.useFakeTimers();
    const m = await loadMailer({ DEV_MAIL_OUTBOX: "1" });
    await m.sendSignInCode("late@example.com", "456456");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(m.readDevOutbox("late@example.com")).toBeUndefined();
  });
});
