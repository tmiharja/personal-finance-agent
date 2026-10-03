import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { imports, proposedActions } from "@/db/schema";
import { withUser } from "@/db/with-user";
import type { MasterKeys } from "@/server/crypto/envelope";
import { getOverviewCounts } from "@/server/finance/overview";
import {
  approveProposal,
  expireOverdueForAllUsers,
  getImportPreview,
  ImportError,
  listPendingProposals,
  previewImport,
  rejectProposal,
} from "@/server/import/service";
import { dumpDatabase, leaks } from "../helpers/no-pii";
import { createTestDb, createUser } from "../helpers/test-db";

const DIR = join(process.cwd(), "evals", "fixtures", "synthetic");
const pdf = (name: string) => new Uint8Array(readFileSync(join(DIR, `${name}.pdf`)));
const keys: MasterKeys = { current: { id: 1, key: randomBytes(32) } };

let db: AppDb;
let close: () => Promise<void>;
const logs: string[] = [];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await createUser(db, "alex", "alex-login@example.com");
  await createUser(db, "other", "other-login@example.com");
  vi.spyOn(console, "info").mockImplementation(
    (...a: unknown[]) => void logs.push(a.map(String).join(" ")),
  );
});
afterAll(async () => {
  vi.restoreAllMocks();
  await close();
});

const pendingImports = async (userId: string) =>
  (await listPendingProposals(db, userId)).flatMap((p) => (p.type === "commit_import" ? [p] : []));

const txCount = async (userId: string) =>
  sqlRows<{ n: number }>(
    await withUser(db, userId, (tx) =>
      tx.execute(sql`select count(*)::int as n from transactions`),
    ),
  )[0]!.n;

describe("import: preview → approve", () => {
  it("previews without touching the ledger", async () => {
    const p = await previewImport(db, "alex", keys, { bytes: pdf("dbs/2026-03") });
    expect(p.status).toBe("previewed");
    expect(p.summary).toMatchObject({
      bank: "DBS",
      statementDate: "2026-03-14",
      allReconciled: true,
      totalsMatch: true,
    });
    expect(p.summary.cards.map((c) => c.productName)).toEqual([
      "DBS SAMPLE VISA SIGNATURE",
      "DBS SAMPLE WORLD MASTERCARD",
    ]);
    expect(p.summary.cards.every((c) => c.isNewCard && c.differenceCents === 0)).toBe(true);
    // Categorised before approval: rules/map first, the (mock) classifier for the rest.
    expect(p.summary.categories.bySource.map).toBeGreaterThan(0);
    expect(p.summary.categories.bySource.none + p.summary.categories.bySource.llm).toBeLessThan(
      p.rows.flat().length,
    );
    expect(p.rows.flat().find((r) => r.descriptor.startsWith("GRAB"))?.categoryName).toBe(
      "Transport",
    );
    expect(p.summary.cards[0]!.counts).toMatchObject({ cardPayments: 1, fees: 2, duplicates: 0 });
    // Sanitised rows for the review screen: no account number on the payment row.
    expect(p.rows[0]!.find((r) => r.kind === "card_payment")!.descriptor).toBe("AUTOPAY");
    expect(await txCount("alex")).toBe(0);
    const pending = await listPendingProposals(db, "alex");
    expect(pending.map((x) => x.id)).toEqual([p.proposalId]);
  });

  it("re-uploading a pending file returns the same preview", async () => {
    const [a] = await listPendingProposals(db, "alex");
    const again = await previewImport(db, "alex", keys, { bytes: pdf("dbs/2026-03") });
    expect(again.proposalId).toBe(a!.id);
  });

  it("another user can neither see nor approve it", async () => {
    const [p] = await pendingImports("alex");
    expect(await getImportPreview(db, "other", keys, p!.importId!)).toBeNull();
    await expect(approveProposal(db, "other", keys, p!.id)).rejects.toMatchObject({
      code: "proposal_not_found",
    });
    await expect(rejectProposal(db, "other", p!.id)).rejects.toMatchObject({
      code: "proposal_not_found",
    });
  });

  it("approving writes exactly the previewed rows, once", async () => {
    const [p] = await listPendingProposals(db, "alex");
    const result = await approveProposal(db, "alex", keys, p!.id);
    expect(result).toMatchObject({ inserted: 27, duplicates: 0, cards: 2, allReconciled: true });
    expect(await txCount("alex")).toBe(27);
    await expect(approveProposal(db, "alex", keys, p!.id)).rejects.toMatchObject({
      code: "proposal_not_pending",
    });
    const [imp] = await withUser(db, "alex", (tx) => tx.select().from(imports));
    expect(imp).toMatchObject({ status: "committed", previewEnc: null });
    const sources = sqlRows<{ source: string | null; n: number }>(
      await withUser(db, "alex", (tx) =>
        tx.execute(
          sql`select category_source as source, count(*)::int as n from transactions group by 1`,
        ),
      ),
    );
    expect(sources.find((s) => s.source === "map")?.n).toBeGreaterThan(0);
    expect(sources.find((s) => s.source === "system")?.n).toBeGreaterThan(0);
    const events = await withUser(db, "alex", (tx) =>
      tx.execute(sql`select event from audit_log where proposal_id = ${p!.id} order by created_at`),
    );
    expect(sqlRows<{ event: string }>(events).map((e) => e.event)).toEqual([
      "proposed",
      "approved",
      "executed",
    ]);
  });

  it("refuses the same file again once it's committed", async () => {
    await expect(
      previewImport(db, "alex", keys, { bytes: pdf("dbs/2026-03") }),
    ).rejects.toMatchObject({
      code: "already_imported",
    });
  });

  it("the same statement in a different file shows every row as a duplicate", async () => {
    const p = await previewImport(db, "alex", keys, {
      bytes: pdf("variants/dbs-2026-03-owner-only"),
    });
    expect(p.summary.cards.reduce((s, c) => s + c.counts.duplicates, 0)).toBe(27);
    expect(p.summary.cards.reduce((s, c) => s + c.counts.newRows, 0)).toBe(0);
    expect(p.rows.flat().every((r) => r.duplicate)).toBe(true);
    // Duplicates are skipped on approval, so nothing new needs review.
    expect(p.summary.categories.toReview).toBe(0);
    await rejectProposal(db, "alex", p.proposalId);
  });

  it("rejecting discards the preview and changes nothing", async () => {
    const p = await previewImport(db, "alex", keys, { bytes: pdf("uob/2026-01") });
    await rejectProposal(db, "alex", p.proposalId);
    expect(await txCount("alex")).toBe(27);
    const [imp] = await withUser(db, "alex", (tx) =>
      tx.select().from(imports).where(eq(imports.id, p.importId)),
    );
    expect(imp).toMatchObject({ status: "discarded", previewEnc: null });
    // A discarded file can be uploaded again.
    const again = await previewImport(db, "alex", keys, { bytes: pdf("uob/2026-01") });
    expect(again.status).toBe("previewed");
  });

  it("a password-protected PDF needs its password", async () => {
    await expect(
      previewImport(db, "alex", keys, { bytes: pdf("variants/uob-2026-01-password") }),
    ).rejects.toMatchObject({
      code: "password_required",
    });
  });

  it("expired previews can't be approved", async () => {
    const [p] = await pendingImports("alex");
    await withUser(db, "alex", (tx) =>
      tx
        .update(proposedActions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(proposedActions.id, p!.id)),
    );
    await expect(approveProposal(db, "alex", keys, p!.id)).rejects.toMatchObject({
      code: "proposal_expired",
    });
    const [imp] = await withUser(db, "alex", (tx) =>
      tx.select().from(imports).where(eq(imports.id, p!.importId!)),
    );
    expect(imp).toMatchObject({ status: "expired", previewEnc: null });
  });

  it("a tampered preview is refused", async () => {
    const p = await previewImport(db, "alex", keys, { bytes: pdf("uob/2026-02") });
    await withUser(db, "alex", (tx) =>
      tx.update(imports).set({ previewEnc: "v1.x.y.z" }).where(eq(imports.id, p.importId)),
    );
    await expect(approveProposal(db, "alex", keys, p.proposalId)).rejects.toBeInstanceOf(
      ImportError,
    );
    expect(await txCount("alex")).toBe(27);
  });
});

describe("import: expiry and races", () => {
  const pending = async (userId: string) => (await getOverviewCounts(db, userId)).pendingApprovals;
  const backdate = (userId: string, p: { proposalId: string; importId: string }) =>
    withUser(db, userId, async (tx) => {
      const past = new Date(Date.now() - 1000);
      await tx
        .update(proposedActions)
        .set({ expiresAt: past })
        .where(eq(proposedActions.id, p.proposalId));
      await tx.update(imports).set({ expiresAt: past }).where(eq(imports.id, p.importId));
    });

  it("an overdue preview stops counting as pending, then the sweep deletes it", async () => {
    const p = await previewImport(db, "other", keys, { bytes: pdf("uob/2026-03") });
    expect(await pending("other")).toBe(1);
    await backdate("other", p);
    expect(await pending("other")).toBe(0);
    const swept = await expireOverdueForAllUsers(db);
    expect(swept.proposals).toBeGreaterThanOrEqual(1);
    const [imp] = await withUser(db, "other", (tx) =>
      tx.select().from(imports).where(eq(imports.id, p.importId)),
    );
    expect(imp).toMatchObject({ status: "expired", previewEnc: null });
    const events = await withUser(db, "other", (tx) =>
      tx.execute(sql`select event, actor from audit_log where proposal_id = ${p.proposalId}`),
    );
    expect(sqlRows<{ event: string; actor: string }>(events)).toContainEqual({
      event: "expired",
      actor: "system",
    });
    // Nothing left for a second run.
    expect(await expireOverdueForAllUsers(db)).toEqual({ proposals: 0, previews: 0 });
  });

  it("concurrent uploads of the same file share one preview", async () => {
    const [a, b] = await Promise.all([
      previewImport(db, "other", keys, { bytes: pdf("uob/2026-04") }),
      previewImport(db, "other", keys, { bytes: pdf("uob/2026-04") }),
    ]);
    expect(a.proposalId).toBe(b.proposalId);
    await rejectProposal(db, "other", a.proposalId);
  });
});

describe("import: bank-account statements", () => {
  const file = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));

  it("a POSB PDF previews as a reconciled bank account, pairs, and commits", async () => {
    const preview = await previewImport(db, "alex", keys, { bytes: file("posb/2026-03.pdf") });
    expect(preview.summary).toMatchObject({ bank: "DBS", kind: "deposit", allReconciled: true });
    const [acct] = preview.summary.cards;
    expect(acct).toMatchObject({ productName: "POSB SAMPLE SAVINGS ACCOUNT", reconciled: true });
    // Balances are stored like rows: money held is negative.
    expect(acct!.totalCents).toBeLessThan(0);
    expect(acct!.counts.income).toBeGreaterThan(0);
    const descriptors = preview.rows.flat().map((r) => r.descriptor);
    expect(descriptors).toContain("PAYNOW TRANSFER OUT");
    expect(descriptors.join("\n")).not.toMatch(/JORDAN|ALEX|000-0/);
    const result = await approveProposal(db, "alex", keys, preview.proposalId);
    expect(result.inserted).toBe(acct!.counts.rows);
  });

  it("the CSV export of the same month adds nothing: every row is a duplicate", async () => {
    const preview = await previewImport(db, "alex", keys, { bytes: file("posb/2026-03.csv") });
    const [acct] = preview.summary.cards;
    expect(acct!.counts.newRows).toBe(0);
    expect(acct!.counts.duplicates).toBe(acct!.counts.rows);
    // The DBS export has no opening balance: unverified, not a pass.
    expect(acct!.reconciled).toBeNull();
    expect(preview.summary.allReconciled).toBe(false);
    // Importing it anyway keeps the balances the PDF verified.
    await approveProposal(db, "alex", keys, preview.proposalId);
    const [march] = sqlRows<{ previous: string | null; reconciled: boolean | null }>(
      await withUser(db, "alex", (tx) =>
        tx.execute(sql`select s.previous_balance_cents::text as previous, s.reconciled
                       from statements s join accounts a on a.id = s.account_id
                       where a.kind = 'deposit' and s.statement_date = '2026-03-31'`),
      ),
    );
    expect(march).toMatchObject({ reconciled: true });
    expect(march!.previous).not.toBeNull();
  });

  it("the UOB account's FAST transfer pairs with the POSB receipt across banks", async () => {
    const preview = await previewImport(db, "alex", keys, { bytes: file("uob-one/2026-03.pdf") });
    expect(preview.summary.pairing?.transfers).toBe(1);
    await approveProposal(db, "alex", keys, preview.proposalId);
    const paired = sqlRows<{ n: number }>(
      await withUser(db, "alex", (tx) =>
        tx.execute(sql`select count(*)::int as n from transactions
                       where merchant_name = 'FAST transfer' and transfer_pair_id is not null
                         and is_transfer`),
      ),
    )[0]!.n;
    expect(paired).toBe(2);
  });

  it("a second account with the same product name stays a separate account", async () => {
    // The same UOB One export, but from another account (a different number).
    const text = readFileSync(join(DIR, "uob-one/2026-04.csv"), "utf8").replace(
      "Account Number:,000-000-000-0",
      "Account Number:,000-000-000-9",
    );
    const other = await previewImport(db, "alex", keys, { bytes: new TextEncoder().encode(text) });
    expect(other.summary.cards[0]).toMatchObject({ isNewCard: true });
    await approveProposal(db, "alex", keys, other.proposalId);
    const ones = sqlRows<{ ordinal: number; keyed: boolean }>(
      await withUser(db, "alex", (tx) =>
        tx.execute(sql`select ordinal, identity_key is not null as keyed from accounts
                       where product_name = 'UOB SAMPLE ONE ACCOUNT' order by ordinal`),
      ),
    );
    expect(ones).toEqual([
      { ordinal: 1, keyed: true },
      { ordinal: 2, keyed: true },
    ]);
  });
});

describe("import: no PII stored or logged", () => {
  it("database dump and logs carry no names, card numbers or raw descriptors", async () => {
    const dump = await dumpDatabase(db);
    expect(leaks(dump)).toEqual([]);
    expect(dump).not.toMatch(/000-00000-0|000-000-000-0/); // bank account numbers
    expect(dump).not.toContain("grab* a-"); // descriptors only ever stored encrypted
    expect(dump).not.toMatch(/\b\d{23}\b/); // reference numbers never stored
    expect(leaks(logs.join("\n"))).toEqual([]);
    expect(logs.some((l) => l.includes('"event":"import.committed"'))).toBe(true);
  });
});
