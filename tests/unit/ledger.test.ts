import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { AppDb } from "@/db/client";
import { statements } from "@/db/schema";
import { withUser } from "@/db/with-user";
import type { MasterKeys } from "@/server/crypto/envelope";
import { getUserCrypto } from "@/server/crypto/user-keys";
import {
  ensureDefaultCategories,
  insertCardStatement,
  upsertCardAccount,
  type CardStatementInput,
} from "@/server/finance/ledger";
import { createTestDb, createUser } from "../helpers/test-db";

let db: AppDb;
let close: () => Promise<void>;
const keys: MasterKeys = { current: { id: 1, key: randomBytes(32) } };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await createUser(db, "u");
});
afterAll(() => close());

const row = (amountCents: number, rawDescriptor: string) => ({
  txnDate: "2026-03-02",
  postDate: null,
  amountCents,
  rawDescriptor,
  fx: null,
  kind: "charge" as const,
});

async function importStatement(patch: Partial<CardStatementInput>) {
  return withUser(db, "u", async (tx) => {
    const crypto = await getUserCrypto(tx, "u", keys);
    const cats = await ensureDefaultCategories(tx, "u");
    const accountId = await upsertCardAccount(tx, "u", {
      bank: "DBS",
      productName: "DBS SAMPLE VISA SIGNATURE",
    });
    const input: CardStatementInput = {
      bank: "DBS",
      accountId,
      productName: "DBS SAMPLE VISA SIGNATURE",
      ordinal: 1,
      statementDate: "2026-03-14",
      dueDate: "2026-04-08",
      minimumPaymentCents: 5000,
      previousBalanceCents: 0,
      totalCents: 10000,
      rows: [row(10000, "SAMPLE STORE A")],
      ...patch,
    };
    const result = await insertCardStatement(tx, crypto, input, cats);
    const [stored] = await tx
      .select()
      .from(statements)
      .where(eq(statements.statementDate, input.statementDate));
    return { result, stored: stored! };
  });
}

describe("card statement re-import", () => {
  it("stores and reconciles a first import", async () => {
    const { result, stored } = await importStatement({});
    expect(result).toMatchObject({ inserted: 1, reconciled: true });
    expect(stored).toMatchObject({
      totalCents: 10000,
      minimumPaymentCents: 5000,
      reconciled: true,
    });
  });

  it("is a no-op for an identical re-import", async () => {
    const { result, stored } = await importStatement({});
    expect(result).toMatchObject({ inserted: 0, duplicates: 1, reconciled: true });
    expect(stored.totalCents).toBe(10000);
  });

  it("refreshes every summary field on a corrected re-import and reconciles what's stored", async () => {
    const { result, stored } = await importStatement({
      totalCents: 11000,
      minimumPaymentCents: 6000,
      dueDate: "2026-04-09",
      rows: [row(10000, "SAMPLE STORE A"), row(1000, "SAMPLE STORE B")],
    });
    expect(result.inserted).toBe(1);
    expect(stored).toMatchObject({
      totalCents: 11000,
      minimumPaymentCents: 6000,
      dueDate: "2026-04-09",
    });
    // Stored rows (10000 + 1000) now match the corrected total.
    expect(stored.reconciled).toBe(true);
  });

  it("flags a re-import whose stored rows no longer add up", async () => {
    const { stored } = await importStatement({
      totalCents: 12000,
      rows: [row(10000, "SAMPLE STORE A")],
    });
    expect(stored).toMatchObject({ totalCents: 12000, reconciled: false });
  });
});

describe("overlapping statements", () => {
  it("counts rows first stored under an earlier statement when reconciling a later one", async () => {
    // The 2026-03-14 statement already holds SAMPLE STORE A and B. A later statement
    // repeats B (an overlapping period) and adds C: B is a duplicate, not inserted
    // again, but it is still part of what the later statement's total covers.
    const { result, stored } = await importStatement({
      statementDate: "2026-04-14",
      previousBalanceCents: 0,
      totalCents: 3000,
      rows: [row(1000, "SAMPLE STORE B"), row(2000, "SAMPLE STORE C")],
    });
    expect(result).toMatchObject({ inserted: 1, duplicates: 1, reconciled: true });
    expect(stored).toMatchObject({ statementDate: "2026-04-14", reconciled: true });
  });
});

describe("account identity: same product name, different numbers", () => {
  it("keeps two same-named accounts apart by their number digest, and reuses each", async () => {
    const { upsertAccount } = await import("@/server/finance/ledger");
    const ids = await withUser(db, "u", async (tx) => {
      const base = {
        bank: "UOB" as const,
        productName: "UOB SAMPLE ONE ACCOUNT",
        kind: "deposit" as const,
      };
      const a = await upsertAccount(tx, "u", { ...base, identityKey: "a".repeat(64) });
      const b = await upsertAccount(tx, "u", { ...base, identityKey: "b".repeat(64) });
      const again = await upsertAccount(tx, "u", { ...base, identityKey: "a".repeat(64) });
      return { a, b, again };
    });
    expect(ids.b).not.toBe(ids.a);
    expect(ids.again).toBe(ids.a);
    const { accounts } = await import("@/db/schema");
    const rows = await withUser(db, "u", (tx) =>
      tx
        .select({ ordinal: accounts.ordinal })
        .from(accounts)
        .where(eq(accounts.productName, "UOB SAMPLE ONE ACCOUNT")),
    );
    expect(rows.map((r) => r.ordinal).sort()).toEqual([1, 2]);
  });

  it("an account created without a number is adopted by the first number seen for it", async () => {
    const { upsertAccount } = await import("@/server/finance/ledger");
    const ids = await withUser(db, "u", async (tx) => {
      const base = {
        bank: "DBS" as const,
        productName: "POSB SAMPLE SAVINGS ACCOUNT",
        kind: "deposit" as const,
      };
      const legacy = await upsertAccount(tx, "u", base);
      const keyed = await upsertAccount(tx, "u", { ...base, identityKey: "c".repeat(64) });
      const other = await upsertAccount(tx, "u", { ...base, identityKey: "d".repeat(64) });
      return { legacy, keyed, other };
    });
    expect(ids.keyed).toBe(ids.legacy);
    expect(ids.other).not.toBe(ids.legacy);
  });
});
