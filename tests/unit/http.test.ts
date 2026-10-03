import { describe, expect, it } from "vitest";
import { isSameOrigin } from "@/server/http";

const req = (headers: Record<string, string>, url = "http://localhost:3000/api/import") =>
  new Request(url, { method: "POST", headers });

describe("same-origin check", () => {
  it("accepts the host the browser addressed, even if the server binds elsewhere", () => {
    expect(isSameOrigin(req({ origin: "http://127.0.0.1:3100", host: "127.0.0.1:3100" }))).toBe(
      true,
    );
  });
  it("uses the forwarded host behind Vercel's proxy", () => {
    expect(
      isSameOrigin(
        req({
          origin: "https://finance.example.com",
          host: "internal:3000",
          "x-forwarded-host": "finance.example.com",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe(true);
  });
  it("rejects other origins and missing origins", () => {
    expect(
      isSameOrigin(req({ origin: "https://evil.example.com", host: "finance.example.com" })),
    ).toBe(false);
    expect(isSameOrigin(req({ host: "finance.example.com" }))).toBe(false);
    expect(isSameOrigin(req({ origin: "null", host: "finance.example.com" }))).toBe(false);
  });
  it("rejects an origin on the right host but the wrong scheme", () => {
    const headers = { host: "finance.example.com", "x-forwarded-proto": "https" };
    expect(isSameOrigin(req({ ...headers, origin: "http://finance.example.com" }))).toBe(false);
    expect(isSameOrigin(req({ ...headers, origin: "https://finance.example.com" }))).toBe(true);
  });
});
