import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    const [stored] = await tx.select().from(statements);
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
