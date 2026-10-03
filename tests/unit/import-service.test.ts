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
import {
  approveProposal,
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
    const [p] = await listPendingProposals(db, "alex");
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
    const [p] = await listPendingProposals(db, "alex");
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

describe("import: no PII stored or logged", () => {
  it("database dump and logs carry no names, card numbers or raw descriptors", async () => {
    const dump = await dumpDatabase(db);
    expect(leaks(dump)).toEqual([]);
    expect(dump).not.toContain("grab* a-"); // descriptors only ever stored encrypted
    expect(dump).not.toMatch(/\b\d{23}\b/); // reference numbers never stored
    expect(leaks(logs.join("\n"))).toEqual([]);
    expect(logs.some((l) => l.includes('"event":"import.committed"'))).toBe(true);
  });
});
