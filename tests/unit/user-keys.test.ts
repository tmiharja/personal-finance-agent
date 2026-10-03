import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { AppDb } from "@/db/client";
import { userKeys } from "@/db/schema";
import { withUser } from "@/db/with-user";
import { generateDek, wrapDek, type MasterKeys } from "@/server/crypto/envelope";
import { getUserCrypto, rewrapAllUserKeys } from "@/server/crypto/user-keys";
import { createTestDb, createUser } from "../helpers/test-db";

let db: AppDb;
let close: () => Promise<void>;
const k1: MasterKeys = { current: { id: 1, key: randomBytes(32) } };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const u of ["a", "b", "c", "d"]) await createUser(db, u);
});
afterAll(() => close());

describe("user keys", () => {
  it("returns the same key on every call", async () => {
    const enc = await withUser(db, "a", async (tx) =>
      (await getUserCrypto(tx, "a", k1)).encrypt("f", "x"),
    );
    const dec = await withUser(db, "a", async (tx) =>
      (await getUserCrypto(tx, "a", k1)).decrypt("f", enc),
    );
    expect(dec).toBe("x");
  });

  it("uses the stored key when another request created it first (no duplicate-key error)", async () => {
    // Simulates losing the race: a key for "b" already exists when this call inserts.
    const winner = generateDek();
    const { wrapped, masterKeyId } = wrapDek(winner, "b", k1);
    await db.insert(userKeys).values({ userId: "b", wrappedDek: wrapped, masterKeyId });
    const crypto = await withUser(db, "b", (tx) => getUserCrypto(tx, "b", k1));
    const { UserCrypto } = await import("@/server/crypto/envelope");
    expect(new UserCrypto(winner, "b").decrypt("f", crypto.encrypt("f", "y"))).toBe("y");
  });

  it("rewraps every user's key on rotation, including users who never come back", async () => {
    const enc = await withUser(db, "c", async (tx) =>
      (await getUserCrypto(tx, "c", k1)).encrypt("f", "kept"),
    );
    await withUser(db, "d", (tx) => getUserCrypto(tx, "d", k1));
    const k2: MasterKeys = { current: { id: 2, key: randomBytes(32) }, previous: k1.current };
    const result = await rewrapAllUserKeys(db, k2);
    expect(result.remaining).toBe(0);
    expect(result.rewrapped).toBeGreaterThanOrEqual(2);
    // MASTER_KEY_PREVIOUS can now be removed: the new key alone still reads old data.
    const onlyNew: MasterKeys = { current: k2.current };
    const dec = await withUser(db, "c", async (tx) =>
      (await getUserCrypto(tx, "c", onlyNew)).decrypt("f", enc),
    );
    expect(dec).toBe("kept");
  });
});
