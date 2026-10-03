import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { accounts, transactions } from "@/db/schema";
import { withUser } from "@/db/with-user";
import type { MasterKeys } from "@/server/crypto/envelope";
import { getUserCrypto } from "@/server/crypto/user-keys";
import { loadFixtureStatements, seedDemoWorkspace } from "@/server/demo/seed";
import { createTestDb, createUser } from "../helpers/test-db";
import { sqlRows } from "@/db/rows";

let db: AppDb;
let close: () => Promise<void>;
const keys: MasterKeys = { current: { id: 1, key: randomBytes(32) } };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await createUser(db, "demo");
  await createUser(db, "other");
});
afterAll(() => close());

describe("demo seed (synthetic fixtures)", () => {
  it("loads 24 synthetic statements", () => {
    const fixtures = loadFixtureStatements();
    expect(fixtures).toHaveLength(24);
    expect(fixtures.every((f) => f.synthetic)).toBe(true);
  });

  it("seeds 12 months of DBS + UOB cards, every card section reconciled", async () => {
    const r = await seedDemoWorkspace(db, "demo", keys);
    expect(r).toEqual({ statements: 24, cards: 4, transactions: 885, reconciled: 48 });
  });

  it("is idempotent: a second run inserts nothing", async () => {
    const r = await seedDemoWorkspace(db, "demo", keys);
    expect(r.transactions).toBe(0);
    const n = await withUser(db, "demo", (tx) =>
      tx.execute(sql`select count(*)::int as n from transactions`),
    );
    expect(sqlRows(n)[0]).toEqual({ n: 885 });
  });

  it("keeps a genuine same-day duplicate charge (two rows, distinct dedupe keys)", async () => {
    const rows = await withUser(db, "demo", (tx) =>
      tx.execute(
        sql`select count(*)::int as n from transactions where txn_date = '2026-07-03' and amount_cents = 8990`,
      ),
    );
    expect(sqlRows(rows)[0]).toEqual({ n: 2 });
  });

  it("stores cards by product name only and descriptors encrypted", async () => {
    const cards = await withUser(db, "demo", (tx) => tx.select().from(accounts));
    expect(cards.map((c) => c.productName).sort()).toEqual([
      "DBS SAMPLE VISA SIGNATURE",
      "DBS SAMPLE WORLD MASTERCARD",
      "UOB SAMPLE CASHBACK",
      "UOB SAMPLE MILES VISA CARD",
    ]);
    const sample = await withUser(db, "demo", async (tx) => {
      const crypto = await getUserCrypto(tx, "demo", keys);
      const [row] = await tx
        .select()
        .from(transactions)
        .where(sql`merchant_name = 'SimplyGo / Transit'`)
        .limit(1);
      return {
        enc: row!.descriptorEnc,
        plain: crypto.decrypt("transactions.descriptor", row!.descriptorEnc),
      };
    });
    expect(sample.enc.startsWith("v1.")).toBe(true);
    expect(sample.enc).not.toContain("BUS/MRT");
    expect(sample.plain).toBe("BUS/MRT # SINGAPORE");
  });

  it("the demo user's data is invisible to another user", async () => {
    const n = await withUser(db, "other", (tx) =>
      tx.execute(sql`select count(*)::int as n from transactions`),
    );
    expect(sqlRows(n)[0]).toEqual({ n: 0 });
  });
});
