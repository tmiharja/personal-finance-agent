import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDb } from "@/db/client";
import { withUser } from "@/db/with-user";
import { seedDemoWorkspace } from "@/server/demo/seed";
import { budgetProgress } from "@/server/finance/budgets";
import { getMonthOverview } from "@/server/finance/overview";
import { monthRange, spendByCategory } from "@/server/finance/spend";
import { runTool } from "@/server/agent/tools";
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

const progress = (month: string, to: string) =>
  withUser(db, "alex", (tx) => budgetProgress(tx, month, to));

describe("budgets (ASK-10)", () => {
  it("measures each budget with the shared spend definition", async () => {
    const p = (await progress("2026-08", "2026-09-30"))!;
    const spent = await withUser(db, "alex", (tx) => spendByCategory(tx, monthRange("2026-08")));
    for (const l of p.lines) {
      expect(l.spentCents).toBe(
        Math.max(0, spent.find((c) => c.category === l.category)?.cents ?? 0),
      );
      expect(l.remainingCents).toBe(l.budgetCents - l.spentCents);
    }
    expect(p.total.spentCents).toBe(p.lines.reduce((s, l) => s + l.spentCents, 0));
  });

  it("a fully imported month is over or within; nothing is projected", async () => {
    const p = (await progress("2026-08", "2026-09-30"))!;
    expect(p).toMatchObject({ daysCovered: 31, daysInMonth: 31, asOf: "2026-08-31" });
    expect(p.lines.find((l) => l.category === "Groceries")).toMatchObject({ status: "over" });
    expect(p.lines.find((l) => l.category === "Dining")).toMatchObject({ status: "over" });
    expect(p.lines.find((l) => l.category === "Transport")).toMatchObject({ status: "over" });
    expect(p.lines.find((l) => l.category === "Shopping")).toMatchObject({
      status: "within",
      projectedCents: null,
    });
  });

  it("part of a month: judged on the days imported, with the pace to month end", async () => {
    const p = (await progress("2026-08", "2026-08-10"))!;
    expect(p).toMatchObject({ daysCovered: 10, daysInMonth: 31, asOf: "2026-08-10" });
    for (const l of p.lines) {
      expect(l.projectedCents).toBe(Math.round((l.spentCents / 10) * 31));
      if (l.spentCents <= l.budgetCents)
        expect(l.status).toBe(l.projectedCents! > l.budgetCents ? "at_risk" : "on_track");
    }
  });

  it("is on Overview, and absent for someone without budgets", async () => {
    const o = (await getMonthOverview(db, "alex", "2026-09"))!;
    expect(o.budgets?.lines.map((l) => l.category).sort()).toEqual([
      "Dining",
      "Groceries",
      "Shopping",
      "Transport",
    ]);
    expect(
      await withUser(db, "other", (tx) => budgetProgress(tx, "2026-09", "2026-09-30")),
    ).toBeNull();
  });

  it("Ask's get_budgets returns the same figures as strings to quote", async () => {
    const p = (await progress("2026-09", "2026-09-30"))!;
    const out = await withUser(db, "alex", (tx) =>
      runTool(
        {
          tx,
          userId: "alex",
          today: "2026-10-03",
          coverage: { from: "2025-08-15", to: "2026-09-30" },
          categories: [],
        },
        "get_budgets",
        { month: null },
      ),
    );
    expect(out.result).toMatchObject({ month: "2026-09", days_covered: 30 });
    const groceries = p.lines.find((l) => l.category === "Groceries")!;
    expect(
      (out.result.budgets as { category: string }[]).find((b) => b.category === "Groceries"),
    ).toEqual({
      category: "Groceries",
      budget_sgd: (groceries.budgetCents / 100).toFixed(2),
      spent_sgd: (groceries.spentCents / 100).toFixed(2),
      remaining_sgd: (groceries.remainingCents / 100).toFixed(2),
      percent_used: groceries.percent,
      projected_month_end_sgd: null,
      status: groceries.status,
    });
  });
});
