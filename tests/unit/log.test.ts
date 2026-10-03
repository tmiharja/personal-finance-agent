import { afterEach, describe, expect, it, vi } from "vitest";
import { logError, logEvent, sanitiseLogFields } from "@/server/log";

afterEach(() => vi.restoreAllMocks());

describe("safe logger", () => {
  it("keeps numbers, booleans and short codes", () => {
    expect(sanitiseLogFields({ rows: 12, ok: true, code: "pii_violation", bank: "DBS" })).toEqual({
      rows: 12,
      ok: true,
      code: "pii_violation",
      bank: "DBS",
    });
  });

  it("drops free text, emails and long numbers", () => {
    expect(
      sanitiseLogFields({
        text: "GRAB* A-ABC SINGAPORE",
        email: "alex@example.com",
        card: "4111111111111111",
        ref: "ref-00000000000000000000000",
      }),
    ).toEqual({ text: "[dropped]", email: "[dropped]", card: "[dropped]", ref: "[dropped]" });
  });

  it("logs errors by class and code only", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError(
      "import",
      Object.assign(new Error("descriptor PAY 4111 1111 1111 1111 failed"), { code: "E1" }),
    );
    const line = spy.mock.calls[0]![0] as string;
    expect(line).not.toContain("4111");
    expect(JSON.parse(line)).toEqual({
      event: "error",
      where: "import",
      errorClass: "Error",
      code: "E1",
    });
  });

  it("writes one JSON line per event", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logEvent("demo.seeded", { transactions: 885 });
    expect(JSON.parse(spy.mock.calls[0]![0] as string)).toEqual({
      event: "demo.seeded",
      transactions: 885,
    });
  });
});
