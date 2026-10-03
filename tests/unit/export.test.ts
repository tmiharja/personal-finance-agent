import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { withUser } from "@/db/with-user";
import { applyDirect, listActionHistory, undoAction } from "@/server/actions";
import type { MasterKeys } from "@/server/crypto/envelope";
import { getUserCrypto } from "@/server/crypto/user-keys";
import { seedDemoWorkspace } from "@/server/demo/seed";
import { csvText, exportCsv } from "@/server/finance/export";
import { readCsv } from "@/server/ingest/parsers/bank-csv";
import { getSettings } from "@/server/finance/settings";
import { createTestDb, createUser } from "../helpers/test-db";

let db: AppDb;
let close: () => Promise<void>;
const keys: MasterKeys = { current: { id: 1, key: randomBytes(32) } };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await createUser(db, "alex");
  await createUser(db, "other");
  await seedDemoWorkspace(db, "alex", keys);
});
afterAll(() => close());

const csvFor = (user: string, filter: Record<string, string> = {}) =>
  withUser(db, user, async (tx) => exportCsv(tx, await getUserCrypto(tx, user, keys), filter));

describe("CSV export (export_csv)", () => {
  it("defuses cells a spreadsheet would run as a formula", () => {
    expect(csvText("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvText("+65")).toBe(`"'+65"`);
    expect(csvText("@SUM")).toBe(`"'@SUM"`);
    expect(csvText('say "hi", ok')).toBe(`"say ""hi"", ok"`);
    expect(csvText(null)).toBe(`""`);
  });

  it("exports every matching row with the sanitised descriptor and no numbers", async () => {
    const all = await csvFor("alex");
    const rows = readCsv(all.csv.replace(/^﻿/, "").trim());
    expect(rows[0]).toEqual([
      "Date",
      "Posted",
      "Account",
      "Merchant",
      "Description",
      "Category",
      "Kind",
      "Amount (SGD)",
      "Foreign amount",
      "Tags",
    ]);
    expect(rows.length - 1).toBe(all.rows);
    expect(all.rows).toBe(1215);
    // Never a card or account number, in any form.
    expect(all.csv).not.toMatch(/\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}|000-0/);
    const grab = await csvFor("alex", { merchant: "Grab", from: "2026-03-01", to: "2026-03-31" });
    const grabRows = readCsv(grab.csv.replace(/^﻿/, "").trim()).slice(1);
    expect(grabRows.length).toBe(grab.rows);
    expect(grabRows.every((r) => r[3] === "Grab" && r[0]!.startsWith("2026-03"))).toBe(true);
    expect((await csvFor("other")).rows).toBe(0);
  });

  it("is recorded in Activity, can't be undone, and is never a pending proposal", async () => {
    const done = await applyDirect(db, "alex", "export_csv", { category: "Dining" });
    expect(done.result.rows).toBeGreaterThan(0);
    const [h] = await listActionHistory(db, "alex", { type: "export_csv" });
    expect(h).toMatchObject({ state: "done", canUndo: false });
    expect(h!.title).toMatch(/^Export \d+ transactions to CSV$/);
    await expect(undoAction(db, "alex", keys, done.proposalId)).rejects.toMatchObject({
      code: "not_undoable",
    });
    const events = sqlRows<{ event: string }>(
      await withUser(db, "alex", (tx) =>
        tx.execute(sql`select event from audit_log where proposal_id = ${done.proposalId}`),
      ),
    ).map((e) => e.event);
    expect(events).toEqual(["proposed", "approved", "executed"]);
  });
});

describe("Settings read model", () => {
  it("lists accounts by product name, expense budgets and rules", async () => {
    await applyDirect(db, "alex", "create_rule", { merchant: "Grab", category: "Transport" });
    const s = await getSettings(db, "alex");
    expect(s.accounts.map((a) => a.kind).sort()).toEqual([
      "card",
      "card",
      "card",
      "card",
      "deposit",
      "deposit",
    ]);
    expect(s.accounts.every((a) => !/\d{6,}/.test(a.name))).toBe(true);
    expect(s.budgets.find((b) => b.category === "Dining")?.cents).toBe(30_000);
    expect(s.budgets.some((b) => b.category === "Income" || b.category === "Transfers")).toBe(
      false,
    );
    expect(s.rules).toEqual([expect.objectContaining({ pattern: "Grab", category: "Transport" })]);
    expect(await getSettings(db, "other")).toMatchObject({ accounts: [], rules: [] });
  });
});
