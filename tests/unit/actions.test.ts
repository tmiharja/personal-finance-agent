import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { alerts, bills, budgets, categories, rules, tags, transactions } from "@/db/schema";
import { withUser } from "@/db/with-user";
import {
  applyDirect,
  approveAny,
  approveMany,
  listActionHistory,
  propose,
  rejectAny,
  undoAction,
} from "@/server/actions";
import { reopenAlert } from "@/server/actions/reopen";
import { nextDueDate } from "@/server/actions/defs/plans";
import type { MasterKeys } from "@/server/crypto/envelope";
import { seedDemoWorkspace } from "@/server/demo/seed";
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

const as = <T>(fn: Parameters<typeof withUser<T>>[2]) => withUser(db, "alex", fn);
const categoryId = async (name: string) =>
  (
    await as((tx) =>
      tx.select({ id: categories.id }).from(categories).where(eq(categories.name, name)),
    )
  )[0]!.id;
const merchantRows = (merchant: string) =>
  as((tx) =>
    tx
      .select({
        id: transactions.id,
        categoryId: transactions.categoryId,
        version: transactions.version,
        isTransfer: transactions.isTransfer,
      })
      .from(transactions)
      .where(eq(transactions.merchantName, merchant)),
  );
const events = async (proposalId: string) =>
  sqlRows<{ event: string; actor: string }>(
    await as((tx) =>
      tx.execute(
        sql`select event, actor from audit_log where proposal_id = ${proposalId} order by created_at, id`,
      ),
    ),
  );

/**
 * Everything a user can change, as one fingerprint. Proposing must leave it
 * exactly as it was: nothing is written until you approve (ACT-10).
 */
async function ledgerFingerprint(user: string): Promise<string> {
  const [r] = sqlRows<{ h: string }>(
    await withUser(db, user, (tx) =>
      tx.execute(sql`select md5(concat_ws('|',
        (select string_agg(id || ':' || version || ':' || coalesce(category_id::text, '') || ':' || is_transfer, ',' order by id) from transactions),
        (select string_agg(id || ':' || category_id || ':' || pattern, ',' order by id) from rules),
        (select string_agg(category_id || ':' || monthly_amount_cents, ',' order by category_id) from budgets),
        (select string_agg(id || ':' || payee || ':' || coalesce(due_day, 0), ',' order by id) from bills),
        (select string_agg(id || ':' || status, ',' order by id) from alerts),
        (select string_agg(id || ':' || ignored, ',' order by id) from subscriptions),
        (select string_agg(transaction_id || ':' || tag_id, ',' order by transaction_id, tag_id) from transaction_tags),
        (select string_agg(id || ':' || name, ',' order by id) from tags)
      )) as h`),
    ),
  );
  return r!.h;
}

describe("the action engine (ACT-1, ACT-4, ACT-6, ACT-8)", () => {
  it("refuses anything off the allowlist, and imports outside the import flow", async () => {
    // An export happens only when you ask for the file, never as a pending proposal.
    await expect(propose(db, "alex", "agent", "export_csv", {})).rejects.toMatchObject({
      code: "action_not_allowed",
    });
    await expect(propose(db, "alex", "user", "export_csv", {})).rejects.toMatchObject({
      code: "action_not_allowed",
    });
    await expect(propose(db, "alex", "agent", "commit_import", {})).rejects.toMatchObject({
      code: "action_not_allowed",
    });
    await expect(propose(db, "alex", "agent", "drop_tables" as never, {})).rejects.toMatchObject({
      code: "action_not_allowed",
    });
  });

  it("validates input before anything is stored", async () => {
    for (const bad of [
      {},
      { merchant: "Grab" },
      { merchant: "Grab", transactionIds: [crypto.randomUUID()], category: "Dining" },
      {
        transactionIds: Array.from({ length: 2001 }, () => crypto.randomUUID()),
        category: "Dining",
      },
    ]) {
      await expect(
        propose(db, "alex", "agent", "recategorise_transactions", bad),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(
      propose(db, "alex", "agent", "recategorise_transactions", {
        merchant: "Grab",
        category: "No such category",
      }),
    ).rejects.toMatchObject({ code: "invalid_category" });
  });

  it("previews exactly, changes nothing until approved, then applies once and audits it", async () => {
    const before = await merchantRows("Shopee");
    const p = await propose(db, "alex", "agent", "recategorise_transactions", {
      merchant: "Shopee",
      category: "Home",
    });
    expect(p.preview).toMatchObject({
      title: `Recategorise ${before.length} transactions to Home`,
      affected: before.length,
    });
    expect(p.preview.changes!.reduce((s, c) => s + c.count, 0)).toBe(before.length);
    expect(await merchantRows("Shopee")).toEqual(before);

    await expect(approveAny(db, "other", keys, p.proposalId)).rejects.toMatchObject({
      code: "proposal_not_found",
    });
    const result = await approveAny(db, "alex", keys, p.proposalId);
    expect(result).toEqual({ changed: before.length });
    const home = await categoryId("Home");
    expect((await merchantRows("Shopee")).every((r) => r.categoryId === home)).toBe(true);
    await expect(approveAny(db, "alex", keys, p.proposalId)).rejects.toMatchObject({
      code: "proposal_not_pending",
    });
    expect(await events(p.proposalId)).toEqual([
      { event: "proposed", actor: "agent" },
      { event: "approved", actor: "user" },
      { event: "executed", actor: "system" },
    ]);
  });

  it("undoes within 30 days, once, and only if nothing it touched changed since (ACT-9)", async () => {
    const before = await merchantRows("Lazada");
    const done = await applyDirect(db, "alex", "recategorise_transactions", {
      merchant: "Lazada",
      category: "Gifts & Donations",
    });
    await expect(undoAction(db, "other", keys, done.proposalId)).rejects.toMatchObject({
      code: "proposal_not_found",
    });
    await undoAction(db, "alex", keys, done.proposalId);
    const after = await merchantRows("Lazada");
    expect(after.map((r) => r.categoryId)).toEqual(before.map((r) => r.categoryId));
    await expect(undoAction(db, "alex", keys, done.proposalId)).rejects.toMatchObject({
      code: "already_undone",
    });
    expect((await events(done.proposalId)).map((e) => e.event)).toEqual([
      "proposed",
      "approved",
      "executed",
      "undone",
    ]);

    // A later edit to one of its rows blocks the undo: it would overwrite your newer choice.
    const again = await applyDirect(db, "alex", "recategorise_transactions", {
      merchant: "Lazada",
      category: "Gifts & Donations",
    });
    await applyDirect(db, "alex", "recategorise_transactions", {
      transactionIds: [after[0]!.id],
      category: "Groceries",
    });
    await expect(undoAction(db, "alex", keys, again.proposalId)).rejects.toMatchObject({
      code: "undo_stale",
    });

    // After 30 days it can't be undone.
    const old = await applyDirect(db, "alex", "set_budget", {
      category: "Dining",
      monthlyAmountCents: 1,
    });
    await db.execute(
      sql`update proposed_actions set executed_at = now() - interval '31 days' where id = ${old.proposalId}`,
    );
    await expect(undoAction(db, "alex", keys, old.proposalId)).rejects.toMatchObject({
      code: "undo_expired",
    });
  });

  it("goes stale instead of applying when a previewed row changed", async () => {
    const rows = await merchantRows("Starbucks");
    const p = await propose(db, "alex", "agent", "recategorise_transactions", {
      merchant: "Starbucks",
      category: "Health",
    });
    await applyDirect(db, "alex", "recategorise_transactions", {
      transactionIds: [rows[0]!.id],
      category: "Groceries",
    });
    await expect(approveAny(db, "alex", keys, p.proposalId)).rejects.toMatchObject({
      code: "proposal_stale",
    });
    const health = await categoryId("Health");
    expect((await merchantRows("Starbucks")).some((r) => r.categoryId === health)).toBe(false);
    expect((await events(p.proposalId)).map((e) => e.event)).toEqual(["proposed", "failed"]);
  });

  it("expires after 24 hours, and refuses a tampered payload", async () => {
    const p = await propose(db, "alex", "agent", "set_budget", {
      category: "Dining",
      monthlyAmountCents: 50_000,
    });
    await db.execute(
      sql`update proposed_actions set expires_at = now() - interval '1 minute' where id = ${p.proposalId}`,
    );
    await expect(approveAny(db, "alex", keys, p.proposalId)).rejects.toMatchObject({
      code: "proposal_expired",
    });

    const q = await propose(db, "alex", "agent", "set_budget", {
      category: "Dining",
      monthlyAmountCents: 50_000,
    });
    await db.execute(
      sql`update proposed_actions set payload = jsonb_set(payload, '{monthlyAmountCents}', '99999999') where id = ${q.proposalId}`,
    );
    await expect(approveAny(db, "alex", keys, q.proposalId)).rejects.toMatchObject({
      code: "proposal_not_found",
    });
  });

  it("approves a batch, each on its own (ACT-5)", async () => {
    const a = await propose(db, "alex", "agent", "set_budget", {
      category: "Transport",
      monthlyAmountCents: 22_000,
    });
    const b = await propose(db, "alex", "agent", "set_budget", {
      category: "Groceries",
      monthlyAmountCents: 60_000,
    });
    await rejectAny(db, "alex", b.proposalId);
    const results = await approveMany(db, "alex", keys, [a.proposalId, b.proposalId]);
    expect(results).toEqual([
      { id: a.proposalId, ok: true },
      { id: b.proposalId, ok: false, code: "proposal_not_pending" },
    ]);
    const set = await as((tx) => tx.select().from(budgets));
    expect(set.map((x) => x.monthlyAmountCents)).toContain(22_000);
    expect(set.map((x) => x.monthlyAmountCents)).not.toContain(60_000);
  });

  it("lists history newest first, filtered by who, change and outcome", async () => {
    const all = await listActionHistory(db, "alex");
    expect(all.length).toBeGreaterThan(5);
    const byAgent = await listActionHistory(db, "alex", { proposer: "agent" });
    expect(byAgent.every((h) => h.proposer === "agent")).toBe(true);
    const undone = await listActionHistory(db, "alex", { state: "undone" });
    expect(undone.length).toBeGreaterThan(0);
    expect(undone.every((h) => h.state === "undone" && !h.canUndo)).toBe(true);
    const budgetsOnly = await listActionHistory(db, "alex", { type: "set_budget", state: "done" });
    expect(budgetsOnly.every((h) => h.type === "set_budget" && h.state === "done")).toBe(true);
    expect(await listActionHistory(db, "other")).toEqual([]);
  });
});

describe("zero unapproved writes (ACT-10, phase exit criterion)", () => {
  it("proposing every action type, as Ask or as you, changes nothing", async () => {
    // The demo has no rules; make one to propose changes to.
    await applyDirect(db, "alex", "create_rule", { merchant: "Starbucks", category: "Dining" });
    const before = await ledgerFingerprint("alex");
    const [rule] = await as((tx) => tx.select({ id: rules.id }).from(rules).limit(1));
    const [alert] = await as((tx) =>
      tx.select({ id: alerts.id }).from(alerts).where(eq(alerts.status, "open")).limit(1),
    );
    const [sub] = sqlRows<{ id: string }>(
      await as((tx) => tx.execute(sql`select id from subscriptions where not ignored limit 1`)),
    );
    const [bill] = await as((tx) => tx.select({ id: bills.id }).from(bills).limit(1));
    expect(rule && alert && sub && bill).toBeTruthy();
    const proposals = [
      ["recategorise_transactions", { merchant: "Grab", category: "Travel" }],
      ["mark_transfer", { merchant: "PayNow transfer" }],
      ["tag_transactions", { merchant: "Grab", tag: "Work" }],
      ["create_rule", { merchant: "Grab", category: "Travel" }],
      ["update_rule", { ruleId: rule!.id, category: "Shopping" }],
      ["delete_rule", { ruleId: rule!.id }],
      ["dismiss_alert", { alertIds: [alert!.id] }],
      ["mark_alert_expected", { alertIds: [alert!.id] }],
      ["set_subscription_status", { subscriptionId: sub!.id, ignored: true }],
      ["set_budget", { category: "Shopping", monthlyAmountCents: 30_000 }],
      ["add_bill", { payee: "Sample Gym", dueDay: 5, expectedAmountCents: 9_900 }],
    ] as const;
    for (const proposer of ["agent", "user"] as const) {
      for (const [type, input] of proposals) {
        const p = await propose(db, "alex", proposer, type, input).catch((e) => e);
        // A proposal, or a refusal: never a change.
        expect(p.proposalId ?? p.code, type).toBeTruthy();
      }
    }
    expect(await ledgerFingerprint("alex")).toBe(before);
  });

  it("another user's ids are refused, never acted on", async () => {
    const [txn] = await merchantRows("Grab");
    const [alert] = await as((tx) => tx.select({ id: alerts.id }).from(alerts).limit(1));
    const before = await ledgerFingerprint("alex");
    for (const [type, input] of [
      ["recategorise_transactions", { transactionIds: [txn!.id], category: "Dining" }],
      ["dismiss_alert", { alertIds: [alert!.id] }],
      ["tag_transactions", { transactionIds: [txn!.id], tag: "x" }],
    ] as const) {
      await expect(applyDirect(db, "other", type, input)).rejects.toHaveProperty("code");
    }
    expect(await ledgerFingerprint("alex")).toBe(before);
  });
});

describe("action types", () => {
  it("create_rule: saves the rule, moves the rows; undo restores both, and the rule it replaced", async () => {
    const travel = await categoryId("Travel");
    const first = await applyDirect(db, "alex", "create_rule", {
      merchant: "Grab",
      category: "Transport",
    });
    const before = await merchantRows("Grab");
    const p = await propose(db, "alex", "user", "create_rule", {
      merchant: "grab",
      category: "Travel",
    });
    expect(p.preview.lines.join(" ")).toMatch(/Replaces the rule/);
    await approveAny(db, "alex", keys, p.proposalId);
    const grabRules = () =>
      as((tx) =>
        tx
          .select({ categoryId: rules.categoryId, pattern: rules.pattern })
          .from(rules)
          .where(eq(rules.pattern, "Grab")),
      );
    expect(await grabRules()).toEqual([{ categoryId: travel, pattern: "Grab" }]);
    await undoAction(db, "alex", keys, p.proposalId);
    expect(await grabRules()).toEqual([
      { categoryId: await categoryId("Transport"), pattern: "Grab" },
    ]);
    expect((await merchantRows("Grab")).map((r) => r.categoryId)).toEqual(
      before.map((r) => r.categoryId),
    );
    expect(first.result).toHaveProperty("ruleId");
  });

  it("update_rule and delete_rule, each undoable", async () => {
    const [rule] = await as((tx) => tx.select().from(rules).where(eq(rules.pattern, "Grab")));
    const u = await applyDirect(db, "alex", "update_rule", {
      ruleId: rule!.id,
      category: "Travel",
    });
    const read = () => as((tx) => tx.select().from(rules).where(eq(rules.id, rule!.id)));
    expect((await read())[0]!.categoryId).toBe(await categoryId("Travel"));
    await undoAction(db, "alex", keys, u.proposalId);
    expect((await read())[0]!.categoryId).toBe(rule!.categoryId);

    const d = await applyDirect(db, "alex", "delete_rule", { ruleId: rule!.id });
    expect(await read()).toEqual([]);
    await undoAction(db, "alex", keys, d.proposalId);
    expect((await read())[0]).toMatchObject({ id: rule!.id, categoryId: rule!.categoryId });
  });

  it("mark_transfer: only PayNow/FAST transfers, and it leaves spending", async () => {
    const [shop] = await merchantRows("Shopee");
    await expect(
      applyDirect(db, "alex", "mark_transfer", { transactionIds: [shop!.id] }),
    ).rejects.toMatchObject({ code: "not_categorisable" });
    const p = await propose(db, "alex", "agent", "mark_transfer", { merchant: "PayNow transfer" });
    await approveAny(db, "alex", keys, p.proposalId);
    expect((await merchantRows("PayNow transfer")).every((r) => r.isTransfer)).toBe(true);
    await undoAction(db, "alex", keys, p.proposalId);
    expect((await merchantRows("PayNow transfer")).some((r) => !r.isTransfer)).toBe(true);
  });

  it("tag_transactions: tags the rows; undo removes the tag it created", async () => {
    const rows = await merchantRows("Grab");
    const t = await applyDirect(db, "alex", "tag_transactions", {
      merchant: "Grab",
      tag: "Work trips",
    });
    const tagged = sqlRows<{ n: number }>(
      await as((tx) => tx.execute(sql`select count(*)::int as n from transaction_tags`)),
    )[0]!.n;
    expect(tagged).toBe(rows.length);
    await undoAction(db, "alex", keys, t.proposalId);
    expect(await as((tx) => tx.select().from(tags))).toEqual([]);
  });

  it("alerts: dismiss and mark expected; Reopen undoes the decision", async () => {
    const [a] = await as((tx) =>
      tx.select({ id: alerts.id }).from(alerts).where(eq(alerts.status, "open")).limit(1),
    );
    const status = async () =>
      (
        await as((tx) => tx.select({ s: alerts.status }).from(alerts).where(eq(alerts.id, a!.id)))
      )[0]!.s;
    const d = await applyDirect(db, "alex", "dismiss_alert", { alertIds: [a!.id] });
    expect(await status()).toBe("dismissed");
    await reopenAlert(db, "alex", keys, a!.id);
    expect(await status()).toBe("open");
    expect((await events(d.proposalId)).map((e) => e.event)).toContain("undone");
    // Nothing open to close: nothing to propose.
    await applyDirect(db, "alex", "mark_alert_expected", { alertIds: [a!.id] });
    await expect(
      applyDirect(db, "alex", "dismiss_alert", { alertIds: [a!.id] }),
    ).rejects.toMatchObject({ code: "nothing_to_change" });
  });

  it("set_budget sets, changes and removes; undo puts back the previous amount", async () => {
    const dining = await categoryId("Dining");
    const amount = async () =>
      (
        await as((tx) =>
          tx
            .select({ c: budgets.monthlyAmountCents })
            .from(budgets)
            .where(eq(budgets.categoryId, dining)),
        )
      )[0]?.c ?? null;
    const was = await amount();
    const p = await propose(db, "alex", "agent", "set_budget", {
      category: "Dining",
      monthlyAmountCents: 45_000,
    });
    expect(p.preview.title).toBe("Budget S$450.00 a month for Dining");
    await approveAny(db, "alex", keys, p.proposalId);
    expect(await amount()).toBe(45_000);
    await undoAction(db, "alex", keys, p.proposalId);
    expect(await amount()).toBe(was);
    await expect(
      propose(db, "alex", "agent", "set_budget", { category: "Salary", monthlyAmountCents: 1 }),
    ).rejects.toMatchObject({ code: "invalid_category" });
  });

  it("add_bill and update_bill: your own bills, with the next due date; undo removes or restores", async () => {
    const a = await applyDirect(db, "alex", "add_bill", {
      payee: "Sample Gym",
      dueDay: 5,
      expectedAmountCents: 9_900,
    });
    const gym = async () =>
      (
        await as((tx) =>
          tx
            .select()
            .from(bills)
            .where(and(eq(bills.payee, "Sample Gym"))),
        )
      )[0];
    expect(await gym()).toMatchObject({ source: "manual", dueDay: 5, expectedAmountCents: 9_900 });
    await expect(
      applyDirect(db, "alex", "add_bill", { payee: "sample gym", dueDay: 6 }),
    ).rejects.toMatchObject({ code: "invalid_reference" });
    const u = await applyDirect(db, "alex", "update_bill", {
      billId: (await gym())!.id,
      dueDay: 20,
    });
    expect((await gym())!.dueDay).toBe(20);
    await undoAction(db, "alex", keys, u.proposalId);
    expect((await gym())!.dueDay).toBe(5);
    await undoAction(db, "alex", keys, a.proposalId);
    expect(await gym()).toBeUndefined();
    // Detected bills belong to the detectors.
    const [detected] = await as((tx) =>
      tx.select({ id: bills.id }).from(bills).where(eq(bills.source, "detected")).limit(1),
    );
    await expect(
      applyDirect(db, "alex", "update_bill", { billId: detected!.id, dueDay: 3 }),
    ).rejects.toMatchObject({ code: "invalid_reference" });
  });

  it("next due date clamps to short months and rolls into next year", () => {
    expect(nextDueDate(31, "2026-02-10")).toBe("2026-02-28");
    expect(nextDueDate(5, "2026-02-10")).toBe("2026-03-05");
    expect(nextDueDate(10, "2026-02-10")).toBe("2026-02-10");
    expect(nextDueDate(1, "2026-12-15")).toBe("2027-01-01");
  });
});

describe("review fixes: undo and staleness never overwrite a newer decision", () => {
  it("reopening one alert from a batch reopens only that alert", async () => {
    const open = await as((tx) =>
      tx.select({ id: alerts.id }).from(alerts).where(eq(alerts.status, "open")).limit(2),
    );
    const [a, b] = open.map((r) => r.id);
    const batch = await applyDirect(db, "alex", "dismiss_alert", { alertIds: [a!, b!] });
    await reopenAlert(db, "alex", keys, a!);
    const status = async (id: string) =>
      (await as((tx) => tx.select({ s: alerts.status }).from(alerts).where(eq(alerts.id, id))))[0]!
        .s;
    expect(await status(a!)).toBe("open");
    expect(await status(b!)).toBe("dismissed");
    // The batch's own undo would now overwrite the reopen: refused.
    await expect(undoAction(db, "alex", keys, batch.proposalId)).rejects.toMatchObject({
      code: "undo_stale",
    });
    await reopenAlert(db, "alex", keys, b!);
  });

  it("a value that changes and changes back still blocks an older undo", async () => {
    const set = (cents: number) =>
      applyDirect(db, "alex", "set_budget", { category: "Health", monthlyAmountCents: cents });
    const first = await set(10_000);
    await set(20_000);
    await set(10_000);
    await expect(undoAction(db, "alex", keys, first.proposalId)).rejects.toMatchObject({
      code: "undo_stale",
    });
    const [sub] = sqlRows<{ id: string }>(
      await as((tx) => tx.execute(sql`select id from subscriptions where not ignored limit 1`)),
    );
    const flip = (ignored: boolean) =>
      applyDirect(db, "alex", "set_subscription_status", { subscriptionId: sub!.id, ignored });
    const hide = await flip(true);
    await flip(false);
    await flip(true);
    await expect(undoAction(db, "alex", keys, hide.proposalId)).rejects.toMatchObject({
      code: "undo_stale",
    });
    await flip(false);
  });

  it("a second budget proposal for a category without one goes stale after the first", async () => {
    const p1 = await propose(db, "alex", "agent", "set_budget", {
      category: "Insurance",
      monthlyAmountCents: 30_000,
    });
    const p2 = await propose(db, "alex", "agent", "set_budget", {
      category: "Insurance",
      monthlyAmountCents: 50_000,
    });
    await approveAny(db, "alex", keys, p1.proposalId);
    await expect(approveAny(db, "alex", keys, p2.proposalId)).rejects.toMatchObject({
      code: "proposal_stale",
    });
  });

  it("undoing an added bill after it was edited is refused", async () => {
    const add = await applyDirect(db, "alex", "add_bill", { payee: "Sample Pool", dueDay: 5 });
    const [bill] = await as((tx) =>
      tx.select({ id: bills.id }).from(bills).where(eq(bills.payee, "Sample Pool")),
    );
    await applyDirect(db, "alex", "update_bill", { billId: bill!.id, dueDay: 20 });
    await expect(undoAction(db, "alex", keys, add.proposalId)).rejects.toMatchObject({
      code: "undo_stale",
    });
  });

  it("a rule goes stale if the merchant's set of rows changed since the preview", async () => {
    const p = await propose(db, "alex", "agent", "create_rule", {
      merchant: "Starbucks",
      category: "Health",
    });
    // A matching row appears without any previewed row changing, as an import would add one.
    const [shop] = await merchantRows("Shopee");
    await db.execute(
      sql`update transactions set merchant_name = 'Starbucks' where id = ${shop!.id}`,
    );
    await expect(approveAny(db, "alex", keys, p.proposalId)).rejects.toMatchObject({
      code: "proposal_stale",
    });
  });

  it("refuses personal data in anything it would store", async () => {
    await expect(
      applyDirect(db, "alex", "add_bill", { payee: "Call 9123 4567", dueDay: 3 }),
    ).rejects.toMatchObject({ code: "contains_personal_data" });
    await expect(
      applyDirect(db, "alex", "tag_transactions", { merchant: "Grab", tag: "4111 1111 1111 1111" }),
    ).rejects.toMatchObject({ code: "contains_personal_data" });
  });
});
