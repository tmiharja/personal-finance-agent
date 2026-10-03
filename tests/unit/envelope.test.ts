import { describe, expect, it } from "vitest";
import {
  generateDek,
  parseKey,
  unwrapDek,
  UserCrypto,
  wrapDek,
  type MasterKeys,
} from "@/server/crypto/envelope";
import { randomBytes } from "node:crypto";

const keys = (id = 1): MasterKeys => ({ current: { id, key: randomBytes(32) } });

describe("envelope encryption", () => {
  it("wraps and unwraps a user key", () => {
    const k = keys();
    const dek = generateDek();
    const { wrapped, masterKeyId } = wrapDek(dek, "u1", k);
    expect(masterKeyId).toBe(1);
    expect(wrapped.startsWith("k1.")).toBe(true);
    expect(unwrapDek(wrapped, "u1", k).equals(dek)).toBe(true);
  });

  it("a wrapped key is bound to its user", () => {
    const k = keys();
    const { wrapped } = wrapDek(generateDek(), "u1", k);
    expect(() => unwrapDek(wrapped, "u2", k)).toThrow();
  });

  it("reads keys wrapped under the previous master key during rotation", () => {
    const old = keys(1);
    const dek = generateDek();
    const { wrapped } = wrapDek(dek, "u1", old);
    const rotated: MasterKeys = { current: { id: 2, key: randomBytes(32) }, previous: old.current };
    expect(unwrapDek(wrapped, "u1", rotated).equals(dek)).toBe(true);
    expect(() => unwrapDek(wrapped, "u1", { current: rotated.current })).toThrow(/no master key/);
  });

  it("encrypts fields with a random IV and binds them to user and field", () => {
    const dek = generateDek();
    const a = new UserCrypto(dek, "u1");
    const c1 = a.encrypt("transactions.descriptor", "GRAB* A-#");
    const c2 = a.encrypt("transactions.descriptor", "GRAB* A-#");
    expect(c1).not.toBe(c2);
    expect(c1).not.toContain("GRAB");
    expect(a.decrypt("transactions.descriptor", c1)).toBe("GRAB* A-#");
    expect(() => a.decrypt("accounts.nickname", c1)).toThrow();
    expect(() => new UserCrypto(dek, "u2").decrypt("transactions.descriptor", c1)).toThrow();
  });

  it("detects tampering", () => {
    const a = new UserCrypto(generateDek(), "u1");
    const c = a.encrypt("f", "hello");
    const parts = c.split(".");
    parts[2] = Buffer.from("tampered").toString("base64url");
    expect(() => a.decrypt("f", parts.join("."))).toThrow();
  });

  it("dedupe keys are deterministic per user and differ across users", () => {
    const dek = generateDek();
    const a = new UserCrypto(dek, "u1");
    expect(a.dedupe(["DBS", "2026-01-02", 1234])).toBe(a.dedupe(["DBS", "2026-01-02", 1234]));
    expect(a.dedupe(["DBS", "2026-01-02", 1234])).toMatch(/^[0-9a-f]{64}$/);
    expect(a.dedupe(["DBS", "2026-01-02", 1234])).not.toBe(
      new UserCrypto(generateDek(), "u2").dedupe(["DBS", "2026-01-02", 1234]),
    );
    // Field boundaries matter: ["ab","c"] ≠ ["a","bc"].
    expect(a.dedupe(["ab", "c"])).not.toBe(a.dedupe(["a", "bc"]));
  });

  it("rejects a master key of the wrong length", () => {
    expect(() => parseKey(Buffer.alloc(16).toString("base64"), "MASTER_KEY")).toThrow(/32 bytes/);
  });
});
