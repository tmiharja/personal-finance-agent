import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { categories, transactions } from "@/db/schema";
import { withUser } from "@/db/with-user";
import { applyDirect, approveAny, propose, rejectAny } from "@/server/actions";
import { loadCategoriseContext } from "@/server/categorise/context";
import type { MasterKeys } from "@/server/crypto/envelope";
import { seedDemoWorkspace } from "@/server/demo/seed";
import {
  countToReview,
  filterHref,
  listFilterOptions,
  listTransactions,
  parseTxnFilter,
  PAGE_SIZE,
} from "@/server/finance/transactions";
import { listPendingProposals } from "@/server/import/service";
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

const list = (params: Record<string, string>) =>
  listTransactions(db, "alex", keys, parseTxnFilter(params));
/** "This transaction only": applied now through the action engine. */
const setTransactionCategory = (_db: AppDb, user: string, id: string, categoryId: string) =>
  applyDirect(db, user, "recategorise_transactions", { transactionIds: [id], categoryId });
const proposeMerchantRule = (_db: AppDb, user: string, id: string, categoryId: string) =>
  propose(db, user, "user", "create_rule", { transactionId: id, categoryId });
const categoryId = async (name: string) =>
  (
    await withUser(db, "alex", (tx) =>
      tx.select({ id: categories.id }).from(categories).where(eq(categories.name, name)),
    )
  )[0]!.id;

describe("listing", () => {
  it("pages newest first and decrypts descriptors for the page only", async () => {
    const page = await list({});
    expect(page.total).toBe(1215);
    expect(page.rows).toHaveLength(PAGE_SIZE);
    expect(page.pages).toBe(Math.ceil(1215 / PAGE_SIZE));
    const dates = page.rows.map((r) => r.txnDate);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(page.rows.every((r) => r.descriptor.length > 0 && !r.descriptor.startsWith("v1."))).toBe(
      true,
    );
  });

  it("filters by category, merchant, dates and spend, with a net total", async () => {
    const dining = await list({ category: "Dining", from: "2026-03-01", to: "2026-03-31" });
    expect(dining.total).toBeGreaterThan(0);
    expect(
      dining.rows.every((r) => r.categoryName === "Dining" && r.txnDate.startsWith("2026-03")),
    ).toBe(true);
    const sum = dining.rows.reduce((s, r) => s + r.amountCents, 0);
    if (dining.pages === 1) expect(dining.totalCents).toBe(sum);
    const netflix = await list({ merchant: "netflix" });
    expect(netflix.total).toBe(12);
    const spend = await list({ spend: "1" });
    expect(spend.rows.some((r) => r.kind === "card_payment")).toBe(false);
  });

  it("drops invalid filter values instead of failing", () => {
    expect(parseTxnFilter({ from: "yesterday", page: "-3", account: "x", q: "grab" })).toEqual({
      q: "grab",
      page: 1,
    });
    expect(filterHref({ category: "Dining", page: 1 })).toBe("/app/transactions?category=Dining");
  });

  it("lists rows to review: uncategorised or below the confidence bar", async () => {
    const n = await countToReview(db, "alex");
    const page = await list({ review: "1" });
    expect(page.total).toBe(n);
    expect(n).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.review)).toBe(true);
  });

  it("shows another user nothing", async () => {
    const page = await listTransactions(db, "other", keys, parseTxnFilter({}));
    expect(page.total).toBe(0);
    const opts = await listFilterOptions(db, "other");
    expect(opts.cards).toEqual([]);
  });
});

describe("corrections", () => {
  it("changes one transaction directly, marked as the user's choice", async () => {
    const [row] = (await list({ merchant: "Shopee" })).rows;
    const groceries = await categoryId("Groceries");
    await setTransactionCategory(db, "alex", row!.id, groceries);
    const [after] = await withUser(db, "alex", (tx) =>
      tx.select().from(transactions).where(eq(transactions.id, row!.id)),
    );
    expect(after).toMatchObject({ categoryId: groceries, categorySource: "user", version: 2 });
  });

  it("confirms a flagged category as is, which takes it off the review list", async () => {
    const before = await countToReview(db, "alex");
    const flagged = (await list({ review: "1" })).rows.find(
      (r) => r.categoryName !== "Uncategorised",
    )!;
    await setTransactionCategory(db, "alex", flagged.id, flagged.categoryId!);
    expect(await countToReview(db, "alex")).toBe(before - 1);
  });

  it("refuses system rows, transfer categories and other users' rows", async () => {
    const [payment] = (await list({ q: "card payment" })).rows;
    const dining = await categoryId("Dining");
    await expect(setTransactionCategory(db, "alex", payment!.id, dining)).rejects.toMatchObject({
      code: "not_categorisable",
    });
    const [shop] = (await list({ merchant: "Shopee" })).rows;
    await expect(
      setTransactionCategory(db, "alex", shop!.id, await categoryId("Transfers")),
    ).rejects.toMatchObject({ code: "invalid_category" });
    await expect(setTransactionCategory(db, "other", shop!.id, dining)).rejects.toMatchObject({
      code: "invalid_category",
    });
  });
});

describe("all from this merchant: a create_rule proposal", () => {
  it("previews the change without touching anything", async () => {
    const starbucks = await list({ merchant: "Starbucks" });
    const health = await categoryId("Health");
    const p = await proposeMerchantRule(db, "alex", starbucks.rows[0]!.id, health);
    expect(p.preview).toMatchObject({
      title: "Always categorise Starbucks as Health",
      // The rule itself, plus every past row it moves.
      affected: starbucks.total + 1,
      changes: [{ from: "Dining", to: "Health", count: starbucks.total }],
    });
    expect(p.preview.sample!.length).toBeLessThanOrEqual(5);
    expect((await list({ merchant: "Starbucks", category: "Dining" })).total).toBe(starbucks.total);
    const pending = await listPendingProposals(db, "alex");
    expect(pending.some((x) => x.id === p.proposalId && x.type === "create_rule")).toBe(true);
    await rejectAny(db, "alex", p.proposalId);
    expect((await list({ merchant: "Starbucks", category: "Dining" })).total).toBe(starbucks.total);
  });

  it("on approval saves the rule and changes exactly the previewed rows, once", async () => {
    const grab = await list({ merchant: "Grab" });
    const travel = await categoryId("Travel");
    const p = await proposeMerchantRule(db, "alex", grab.rows[0]!.id, travel);
    await expect(approveAny(db, "other", keys, p.proposalId)).rejects.toMatchObject({
      code: "proposal_not_found",
    });
    const result = await approveAny(db, "alex", keys, p.proposalId);
    expect(result).toMatchObject({ recategorised: grab.total });
    expect((await list({ merchant: "Grab", category: "Travel" })).total).toBe(grab.total);
    await expect(approveAny(db, "alex", keys, p.proposalId)).rejects.toMatchObject({
      code: "proposal_not_pending",
    });
    // Future imports: the rule is in the categoriser's context.
    const ctx = await withUser(db, "alex", (tx) => loadCategoriseContext(tx, "alex"));
    expect(ctx.rules).toContainEqual(
      expect.objectContaining({ match: "merchant", pattern: "Grab", categoryName: "Travel" }),
    );
    const events = sqlRows<{ event: string }>(
      await withUser(db, "alex", (tx) =>
        tx.execute(
          sql`select event from audit_log where proposal_id = ${p.proposalId} order by created_at`,
        ),
      ),
    ).map((e) => e.event);
    expect(events).toEqual(["proposed", "approved", "executed"]);
  });

  it("goes stale instead of applying if a previewed row changed", async () => {
    const lazada = await list({ merchant: "Lazada" });
    const p = await proposeMerchantRule(db, "alex", lazada.rows[0]!.id, await categoryId("Home"));
    await setTransactionCategory(db, "alex", lazada.rows[1]!.id, await categoryId("Groceries"));
    await expect(approveAny(db, "alex", keys, p.proposalId)).rejects.toMatchObject({
      code: "proposal_stale",
    });
    expect((await list({ merchant: "Lazada", category: "Home" })).total).toBe(0);
  });
});
