import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDb } from "@/db/client";
import { withUser } from "@/db/with-user";
import { runDetectors } from "@/server/detect/run";
import { seedDemoWorkspace } from "@/server/demo/seed";
import { mondayOf, weekCoverage, weeklyDigest } from "@/server/finance/digest";
import { spendTotals } from "@/server/finance/spend";
import { createTestDb, createUser } from "../helpers/test-db";

let db: AppDb;
let close: () => Promise<void>;
const keys = { current: { id: 1, key: randomBytes(32) } };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await createUser(db, "alex");
  await createUser(db, "other");
  await seedDemoWorkspace(db, "alex", keys);
  await runDetectors(db, "alex", keys, "2026-10-03");
});
afterAll(() => close());

describe("weekly digest (DET-10)", () => {
  it("weeks run Monday to Sunday", () => {
    expect(mondayOf("2026-10-03")).toBe("2026-09-28"); // Saturday
    expect(mondayOf("2026-09-28")).toBe("2026-09-28"); // Monday
    expect(mondayOf("2026-10-04")).toBe("2026-09-28"); // Sunday
  });

  it("reports last full week against the week before, with the shared spend definition", async () => {
    const d = await weeklyDigest(db, "alex", "2026-09-03");
    expect(d.week).toEqual({ from: "2026-08-24", to: "2026-08-30" });
    expect(d).toMatchObject({ imported: true, partial: false });
    const [now, before] = await withUser(db, "alex", (tx) =>
      Promise.all([
        spendTotals(tx, d.week),
        spendTotals(tx, { from: "2026-08-17", to: "2026-08-23" }),
      ]),
    );
    expect(d.spentCents).toBe(now.spentCents);
    expect(d.previousCents).toBe(before.spentCents);
    expect(d.topCategories.length).toBeLessThanOrEqual(3);
    expect(d.dueSoon.every((x) => x.due >= "2026-09-03" && x.due <= "2026-09-10")).toBe(true);
  });

  it("a week the card statements don't reach yet is partial, not complete", async () => {
    // Cards are imported to mid-September, bank accounts to 30 September.
    expect(await weeklyDigest(db, "alex", "2026-10-03")).toMatchObject({
      week: { from: "2026-09-21", to: "2026-09-27" },
      imported: false,
      partial: true,
    });
  });

  it("a missing statement leaves its weeks uncovered, even with later ones imported", () => {
    const jan = { account: "a", date: "2026-01-14" };
    const mar = { account: "a", date: "2026-03-14" };
    expect(weekCoverage([jan, mar], { from: "2026-02-02", to: "2026-02-08" })).toBe("none");
    expect(weekCoverage([jan, mar], { from: "2026-02-23", to: "2026-03-01" })).toBe("full");
    // A second account that started later isn't expected to cover early weeks.
    expect(
      weekCoverage([jan, { account: "b", date: "2026-06-30" }], {
        from: "2026-01-05",
        to: "2026-01-11",
      }),
    ).toBe("full");
  });

  it("says when the week isn't imported yet", async () => {
    const d = await weeklyDigest(db, "alex", "2026-11-20");
    expect(d).toMatchObject({
      imported: false,
      partial: false,
      dataTo: "2026-09-30",
      spentCents: 0,
    });
    expect(await weeklyDigest(db, "other", "2026-10-03")).toMatchObject({
      imported: false,
      dataTo: null,
      alerts: [],
      dueSoon: [],
    });
  });
});

describe("bills you added roll on", () => {
  it("once its due date passes, the daily run moves a manual bill to its next due date", async () => {
    const { applyDirect } = await import("@/server/actions");
    const { bills } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await applyDirect(db, "alex", "add_bill", { payee: "Sample Gym", dueDay: 5 });
    const due = async () =>
      (
        await withUser(db, "alex", (tx) =>
          tx.select({ d: bills.dueDate }).from(bills).where(eq(bills.payee, "Sample Gym")),
        )
      )[0]!.d;
    expect(await due()).toMatch(/-05$/);
    await runDetectors(db, "alex", keys, "2026-11-20");
    expect(await due()).toBe("2026-12-05");
  });
});
