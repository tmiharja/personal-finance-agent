import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDb } from "@/db/client";
import { withUser } from "@/db/with-user";
import { runDetectors } from "@/server/detect/run";
import { seedDemoWorkspace } from "@/server/demo/seed";
import { mondayOf, weeklyDigest } from "@/server/finance/digest";
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
    const d = await weeklyDigest(db, "alex", "2026-10-03");
    expect(d.week).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(d.imported).toBe(true);
    const [now, before] = await withUser(db, "alex", (tx) =>
      Promise.all([
        spendTotals(tx, d.week),
        spendTotals(tx, { from: "2026-09-14", to: "2026-09-20" }),
      ]),
    );
    expect(d.spentCents).toBe(now.spentCents);
    expect(d.previousCents).toBe(before.spentCents);
    expect(d.topCategories.length).toBeLessThanOrEqual(3);
    expect(d.dueSoon.every((x) => x.due >= "2026-10-03" && x.due <= "2026-10-10")).toBe(true);
  });

  it("says when the week isn't imported yet", async () => {
    const d = await weeklyDigest(db, "alex", "2026-11-20");
    expect(d).toMatchObject({ imported: false, dataTo: "2026-09-30", spentCents: 0 });
    expect(await weeklyDigest(db, "other", "2026-10-03")).toMatchObject({
      imported: false,
      dataTo: null,
      alerts: [],
      dueSoon: [],
    });
  });
});
