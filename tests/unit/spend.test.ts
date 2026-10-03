import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { AppDb } from "@/db/client";
import { withUser } from "@/db/with-user";
import { loadFixtureStatements, seedDemoWorkspace } from "@/server/demo/seed";
import { getMonthOverview } from "@/server/finance/overview";
import {
  addMonths,
  monthRange,
  monthlySpend,
  spendByCategory,
  spendTotals,
  topMerchants,
} from "@/server/finance/spend";
import { createTestDb, createUser } from "../helpers/test-db";

let db: AppDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await createUser(db, "alex");
  await createUser(db, "other");
  await seedDemoWorkspace(db, "alex", { current: { id: 1, key: randomBytes(32) } });
});
afterAll(() => close());

// Ground truth straight from the fixtures, independent of the SQL.
const rows = loadFixtureStatements().flatMap((s) => s.cards.flatMap((c) => c.rows));
const inMonth = (m: string) => rows.filter((r) => r.txnDate.startsWith(m));
const spendOf = (rs: typeof rows) =>
  rs
    .filter((r) => ["charge", "fee", "refund"].includes(r.kind))
    .reduce((s, r) => s + r.amountCents, 0);

describe("spend definitions (shared by Overview and Ask)", () => {
  it("nets refunds into spend and excludes card payments and cashback", async () => {
    const t = await withUser(db, "alex", (tx) => spendTotals(tx, monthRange("2026-02")));
    const feb = inMonth("2026-02");
    expect(t.spentCents).toBe(spendOf(feb));
    expect(t.refundsCents).toBe(
      feb.filter((r) => r.kind === "refund").reduce((s, r) => s + r.amountCents, 0),
    );
    expect(t.refundsCents).toBeLessThan(0);
    expect(t.excluded.cardPayments).toBe(feb.filter((r) => r.kind === "card_payment").length);
    expect(t.cardPaymentsCents).toBeLessThan(0);
  });

  it("breaks spend down by category and merchant", async () => {
    const range = monthRange("2026-03");
    const [cats, total, merchants] = await withUser(db, "alex", (tx) =>
      Promise.all([
        spendByCategory(tx, range),
        spendTotals(tx, range),
        topMerchants(tx, range, {}, 3),
      ]),
    );
    expect(cats.reduce((s, c) => s + c.cents, 0)).toBe(total.spentCents);
    expect(cats.map((c) => c.cents)).toEqual([...cats.map((c) => c.cents)].sort((a, b) => b - a));
    const dining = await withUser(db, "alex", (tx) =>
      spendTotals(tx, range, { category: "Dining" }),
    );
    expect(cats.find((c) => c.category === "Dining")?.cents).toBe(dining.spentCents);
    expect(merchants).toHaveLength(3);
    expect(merchants[0]!.cents).toBeGreaterThanOrEqual(merchants[2]!.cents);
  });

  it("keeps a category whose refunds exceed its charges, so categories add up to spend", async () => {
    const { setTransactionCategory } = await import("@/server/finance/transactions");
    const { categories, transactions } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const [refund] = await withUser(db, "alex", (tx) =>
      tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.kind, "refund"), eq(transactions.txnDate, "2026-02-09"))),
    );
    const [gifts] = await withUser(db, "alex", (tx) =>
      tx
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.name, "Gifts & Donations")),
    );
    await setTransactionCategory(db, "alex", refund!.id, gifts!.id);
    const range = monthRange("2026-02");
    const [cats, total] = await withUser(db, "alex", (tx) =>
      Promise.all([spendByCategory(tx, range), spendTotals(tx, range)]),
    );
    expect(cats.find((c) => c.category === "Gifts & Donations")?.cents).toBeLessThan(0);
    expect(cats.reduce((s, c) => s + c.cents, 0)).toBe(total.spentCents);
  });

  it("returns every month in the range, empty months included", async () => {
    const months = await withUser(db, "alex", (tx) =>
      monthlySpend(tx, { from: "2025-06-01", to: "2025-12-31" }),
    );
    expect(months.map((m) => m.month)).toEqual([
      "2025-06",
      "2025-07",
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
    ]);
    expect(months[0]!.cents).toBe(0);
    expect(months.find((m) => m.month === "2025-10")!.cents).toBe(spendOf(inMonth("2025-10")));
  });

  it("month helpers handle year ends and leap years", () => {
    expect(addMonths("2025-12", 1)).toBe("2026-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});

describe("overview", () => {
  it("defaults to the latest month with data and returns a 12-month trend", async () => {
    const o = (await getMonthOverview(db, "alex"))!;
    const latest = rows
      .map((r) => r.txnDate)
      .sort()
      .at(-1)!
      .slice(0, 7);
    expect(o.month).toBe(latest);
    expect(o.trend).toHaveLength(12);
    expect(o.trend.at(-1)!.month).toBe(latest);
    expect(o.previous).not.toBeNull();
  });

  it("ignores a month outside the data and is empty for a new user", async () => {
    expect((await getMonthOverview(db, "alex", "1999-01"))!.month).not.toBe("1999-01");
    expect((await getMonthOverview(db, "alex", "2026-03"))!.month).toBe("2026-03");
    expect(await getMonthOverview(db, "other")).toBeNull();
  });
});
