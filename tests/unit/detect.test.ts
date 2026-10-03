import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { alerts, bills, subscriptions } from "@/db/schema";
import { withUser } from "@/db/with-user";
import { seedDemoWorkspace } from "@/server/demo/seed";
import { chargeAlerts, dueAlerts } from "@/server/detect/alerts";
import type { Ledger, Row } from "@/server/detect/ledger";
import { detectSubscriptions } from "@/server/detect/recurring";
import { runDetectors } from "@/server/detect/run";
import { describeRow } from "@/server/finance/ledger";
import { createTestDb, createUser } from "../helpers/test-db";

let db: AppDb;
let close: () => Promise<void>;
const keys = { current: { id: 1, key: randomBytes(32) } };
const TODAY = "2026-10-03";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await createUser(db, "alex");
  await createUser(db, "other");
  await seedDemoWorkspace(db, "alex", keys);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await close();
});

type Planted = {
  type: string;
  merchant?: string;
  payee?: string;
  currency?: string;
  date?: string;
  expect?: string[];
};
const planted = (
  JSON.parse(readFileSync(join(process.cwd(), "evals/fixtures/synthetic/ledger.json"), "utf8")) as {
    planted: Planted[];
  }
).planted;
const name = (raw: string) => describeRow(raw).merchantName.toLowerCase();

describe("golden set: the events planted in the synthetic statements", () => {
  it("finds every planted event (recall) and little else (precision)", async () => {
    const result = await runDetectors(db, "alex", keys, TODAY);
    const [subs, found, raised] = await withUser(db, "alex", (tx) =>
      Promise.all([
        tx.select().from(subscriptions),
        tx.select().from(bills),
        tx.select().from(alerts),
      ]),
    );
    expect(result.newAlerts).toBe(raised.length);

    // What the fixtures say should be found, as (kind, subject) pairs.
    const expected = new Set<string>();
    for (const p of planted) {
      if (p.type === "subscription") expected.add(`subscription|${name(p.merchant!)}`);
      if (p.type === "trial_conversion") {
        expected.add(`subscription|${name(p.merchant!)}`);
        expected.add(`trial_conversion|${name(p.merchant!)}`);
      }
      for (const e of p.expect ?? [])
        if (e.startsWith("price_increase")) expected.add(`price_increase|${name(p.merchant!)}`);
      if (p.type === "bill") expected.add(`bill|${name(p.payee!)}`);
      if (p.type === "fee") expected.add("card_fee|dbs sample visa signature");
      if (p.type === "unusual_first_time_merchant")
        expected.add(`first_time_merchant|${name(p.merchant!)}`);
      if (p.type === "duplicate") expected.add(`duplicate_charge|${name(p.merchant!)}`);
      if (p.type === "unusual_amount") expected.add(`unusual_amount|${name(p.merchant!)}`);
      if (p.type === "foreign_charge") expected.add(`foreign_charge|${p.currency!.toLowerCase()}`);
      if (p.type === "fx_trip") expected.add(`foreign_charge|${p.currency!.toLowerCase()}`);
    }
    const detected = [
      ...subs.map((s) => `subscription|${s.merchantName.toLowerCase()}`),
      ...found.map((b) => `bill|${b.payee.toLowerCase()}`),
      ...raised.map((a) => `${a.type}|${(a.subject ?? "").toLowerCase()}`),
    ];
    const hits = new Set(detected.filter((d) => expected.has(d)));
    const recall = hits.size / expected.size;
    const precision = detected.filter((d) => expected.has(d)).length / detected.length;
    console.log(
      `detectors: recall ${hits.size}/${expected.size}, precision ${detected.filter((d) => expected.has(d)).length}/${detected.length}`,
    );
    expect([...expected].filter((e) => !hits.has(e))).toEqual([]);
    expect(recall).toBeGreaterThanOrEqual(0.8);
    expect(precision).toBeGreaterThanOrEqual(0.9);
  });

  it("reports the planted price rise on the day it started", async () => {
    const [netflix] = await withUser(db, "alex", (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.merchantName, "Netflix")),
    );
    expect(netflix).toMatchObject({
      amountCents: 1998,
      previousAmountCents: 1798,
      priceChangedOn: "2026-05-05",
      cadence: "monthly",
      status: "active",
    });
  });

  it("is idempotent, and never reopens a dismissed alert", async () => {
    const [first] = await withUser(db, "alex", (tx) => tx.select().from(alerts).limit(1));
    await withUser(db, "alex", (tx) =>
      tx.update(alerts).set({ status: "dismissed" }).where(eq(alerts.id, first!.id)),
    );
    const again = await runDetectors(db, "alex", keys, TODAY);
    expect(again.newAlerts).toBe(0);
    const [still] = await withUser(db, "alex", (tx) =>
      tx.select().from(alerts).where(eq(alerts.id, first!.id)),
    );
    expect(still!.status).toBe("dismissed");
  });

  it("finds nothing for another user", async () => {
    expect(await runDetectors(db, "other", keys, TODAY)).toEqual({
      subscriptions: 0,
      bills: 0,
      newAlerts: 0,
    });
  });
});

// ------------------------------------------------------------------ unit cases

let n = 0;
const row = (date: string, cents: number, merchant = "Acme", over: Partial<Row> = {}): Row => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  date,
  amountCents: cents,
  merchant,
  key: merchant.toLowerCase(),
  kind: "charge",
  category: "Shopping",
  fxCurrency: null,
  fxAmount: null,
  accountId: "card",
  card: "Card",
  ...over,
});
const ledger = (rows: Row[], coverage = "2026-12-31"): Ledger => ({
  rows,
  statements: [],
  coverage: new Map([["card", coverage]]),
});

describe("subscriptions (DET-1)", () => {
  it("needs three charges on one cadence; annual needs two", () => {
    expect(detectSubscriptions(ledger([row("2026-01-10", 999), row("2026-02-10", 999)]))).toEqual(
      [],
    );
    const weekly = detectSubscriptions(
      ledger(
        [row("2026-03-02", 500), row("2026-03-09", 500), row("2026-03-16", 500)],
        "2026-03-20",
      ),
    );
    expect(weekly[0]).toMatchObject({
      cadence: "weekly",
      monthlyCents: Math.round((500 * 52) / 12),
    });
    const annual = detectSubscriptions(
      ledger([row("2025-04-01", 12000), row("2026-04-03", 12000)], "2026-05-01"),
    );
    expect(annual[0]).toMatchObject({ cadence: "annual", monthlyCents: 1000 });
  });

  it("tolerates ±4 days on monthly charges and ±10% on amounts, but not a varying bill", () => {
    const ok = detectSubscriptions(
      ledger(
        [row("2026-01-28", 1000), row("2026-03-01", 1050), row("2026-03-29", 980)],
        "2026-04-10",
      ),
    );
    expect(ok[0]?.cadence).toBe("monthly");
    const varying = detectSubscriptions(
      ledger([
        row("2026-01-05", 4200),
        row("2026-02-05", 6100),
        row("2026-03-05", 4700),
        row("2026-04-05", 5900),
      ]),
    );
    expect(varying).toEqual([]);
  });

  it("marks a missed charge overdue, then possibly cancelled", () => {
    const rows = [row("2026-01-05", 1500), row("2026-02-05", 1500), row("2026-03-05", 1500)];
    expect(detectSubscriptions(ledger(rows, "2026-04-07"))[0]!.status).toBe("active");
    expect(detectSubscriptions(ledger(rows, "2026-04-20"))[0]!.status).toBe("overdue");
    expect(detectSubscriptions(ledger(rows, "2026-06-01"))[0]!.status).toBe("possibly_cancelled");
  });
});

describe("unusual charges (DET-4)", () => {
  it("ignores small duplicate transit and food charges", () => {
    const rides = [
      row("2026-02-01", 180, "Transit", { category: "Transport" }),
      row("2026-02-01", 180, "Transit", { category: "Transport" }),
    ];
    expect(chargeAlerts(ledger(rides), new Set())).toEqual([]);
  });
  it("needs history before calling a merchant new", () => {
    expect(chargeAlerts(ledger([row("2026-01-01", 50000, "Big Shop")]), new Set())).toEqual([]);
    const later = chargeAlerts(
      ledger([row("2026-01-01", 1000, "Cafe"), row("2026-03-01", 50000, "Big Shop")]),
      new Set(),
    );
    expect(later.map((a) => a.type)).toEqual(["first_time_merchant"]);
  });
});

describe("card payments due (DET-7)", () => {
  const due: Ledger = {
    rows: [],
    statements: [
      {
        accountId: "card",
        card: "Card",
        statementDate: "2026-09-14",
        dueDate: "2026-10-05",
        minimumPaymentCents: 5000,
        totalCents: 120000,
      },
    ],
    coverage: new Map(),
  };
  it("alerts within 3 days of the due date when no payment is recorded", () => {
    expect(dueAlerts(due, "2026-10-01")).toEqual([]);
    expect(dueAlerts(due, "2026-10-03")[0]!.reason).toContain("due on 5 Oct 2026");
    expect(dueAlerts(due, "2026-10-06")).toEqual([]);
    const paid = {
      ...due,
      rows: [row("2026-09-30", -120000, "Card payment", { kind: "card_payment" })],
    };
    expect(dueAlerts(paid, "2026-10-03")).toEqual([]);
  });
});

describe("read model and the user's own decisions", () => {
  it("totals running subscriptions per month and keeps ignored ones out", async () => {
    const { listSubscriptions, setSubscriptionIgnored } = await import("@/server/detect/read");
    const before = await listSubscriptions(db, "alex");
    const running = before.items.filter((s) => s.status === "active" || s.status === "overdue");
    expect(before.monthlyCents).toBe(running.reduce((s, x) => s + x.monthlyCents, 0));
    const spotify = before.items.find((s) => s.merchant === "Spotify")!;
    expect(await setSubscriptionIgnored(db, "other", spotify.id, true)).toBe(false);
    expect(await setSubscriptionIgnored(db, "alex", spotify.id, true)).toBe(true);
    await runDetectors(db, "alex", keys, TODAY);
    const after = await listSubscriptions(db, "alex");
    expect(after.items.some((s) => s.merchant === "Spotify")).toBe(false);
    expect(after.monthlyCents).toBe(before.monthlyCents - spotify.monthlyCents);
    expect(
      (await listSubscriptions(db, "alex", { includeIgnored: true })).items.find(
        (s) => s.merchant === "Spotify",
      )?.status,
    ).toBe("ignored");
  });

  it("shows each card's latest due, paid once a later payment appears", async () => {
    const { listBills } = await import("@/server/detect/read");
    const { cards, bills: found } = await listBills(db, "alex");
    expect(cards).toHaveLength(4);
    expect(cards.every((c) => c.dueDate && c.statementDate.startsWith("2026-09"))).toBe(true);
    expect(cards.some((c) => !c.paid)).toBe(true);
    expect(found.map((b) => b.payee).sort()).toEqual(["SP Group", "Singtel"]);
    expect((await listBills(db, "other")).cards).toEqual([]);
  });

  it("lists alerts with their transactions, and only the owner can close them", async () => {
    const { listAlerts, setAlertStatus, countOpenAlerts } = await import("@/server/detect/read");
    const open = await listAlerts(db, "alex");
    const dup = open.find((a) => a.type === "duplicate_charge")!;
    expect(dup.transactions).toHaveLength(2);
    expect(dup.transactions.every((t) => t.merchant === "Lazada" && t.amountCents === 8990)).toBe(
      true,
    );
    const n = await countOpenAlerts(db, "alex");
    expect(await setAlertStatus(db, "other", dup.id, "dismissed")).toBe(false);
    expect(await setAlertStatus(db, "alex", dup.id, "expected")).toBe(true);
    expect(await countOpenAlerts(db, "alex")).toBe(n - 1);
    expect((await listAlerts(db, "alex", { status: "closed" })).map((a) => a.id)).toContain(dup.id);
    expect(await listAlerts(db, "other")).toEqual([]);
  });
});
