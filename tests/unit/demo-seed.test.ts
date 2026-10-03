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
  it("loads 48 synthetic statements: 24 card, 24 bank-account", () => {
    const fixtures = loadFixtureStatements();
    expect(fixtures).toHaveLength(48);
    expect(fixtures.filter((f) => f.kind === "deposit")).toHaveLength(24);
    expect(fixtures.every((f) => f.synthetic)).toBe(true);
  });

  it("seeds 12 months of cards and bank accounts, all reconciled, every transfer paired", async () => {
    const r = await seedDemoWorkspace(db, "demo", keys);
    // 885 card rows + 330 bank rows; 48 card sections + 24 bank statements reconcile;
    // 48 card bills paid from the bank + 12 own transfers are paired (PRD §12 exit criterion).
    expect(r).toEqual({
      statements: 48,
      cards: 4,
      bankAccounts: 2,
      transactions: 1215,
      reconciled: 72,
      paired: 60,
    });
  });

  it("is idempotent: a second run inserts nothing", async () => {
    const r = await seedDemoWorkspace(db, "demo", keys);
    expect(r.transactions).toBe(0);
    const n = await withUser(db, "demo", (tx) =>
      tx.execute(sql`select count(*)::int as n from transactions`),
    );
    expect(sqlRows(n)[0]).toEqual({ n: 1215 });
  });

  it("keeps a genuine same-day duplicate charge (two rows, distinct dedupe keys)", async () => {
    const rows = await withUser(db, "demo", (tx) =>
      tx.execute(
        sql`select count(*)::int as n from transactions where txn_date = '2026-07-03' and amount_cents = 8990`,
      ),
    );
    expect(sqlRows(rows)[0]).toEqual({ n: 2 });
  });

  it("stores cards and accounts by product name only and descriptors encrypted", async () => {
    const cards = await withUser(db, "demo", (tx) => tx.select().from(accounts));
    expect(cards.map((c) => `${c.kind} ${c.productName}`).sort()).toEqual([
      "card DBS SAMPLE VISA SIGNATURE",
      "card DBS SAMPLE WORLD MASTERCARD",
      "card UOB SAMPLE CASHBACK",
      "card UOB SAMPLE MILES VISA CARD",
      "deposit POSB SAMPLE SAVINGS ACCOUNT",
      "deposit UOB SAMPLE ONE ACCOUNT",
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
