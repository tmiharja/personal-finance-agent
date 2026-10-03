import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { accounts, auditLog, transactions, user, USER_TABLES } from "@/db/schema";
import { withUser } from "@/db/with-user";
import type { AppDb } from "@/db/client";
import { createTestDb, createUser, ownerCount } from "../helpers/test-db";
import { sqlRows } from "@/db/rows";

/** Drizzle wraps driver errors; the Postgres message is on `cause`. */
async function pgError(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as { cause?: { message?: string } }).cause?.message ?? e);
  }
  return "no error";
}

let db: AppDb;
let close: () => Promise<void>;
const A = "user-a";
const B = "user-b";

async function addCard(userId: string, productName: string) {
  return withUser(db, userId, async (tx) => {
    const [acct] = await tx
      .insert(accounts)
      .values({ userId, bank: "DBS", kind: "card", productName })
      .returning();
    await tx.insert(transactions).values({
      userId,
      accountId: acct!.id,
      txnDate: "2026-01-02",
      amountCents: 1234,
      descriptorEnc: "v1.test",
      kind: "charge",
      dedupeKey: `${userId}`.padEnd(64, "0"),
    });
    return acct!;
  });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await createUser(db, A);
  await createUser(db, B);
  await addCard(A, "DBS SAMPLE VISA SIGNATURE");
  await addCard(B, "UOB SAMPLE CASHBACK");
});
afterAll(() => close());

describe("row-level security: two users", () => {
  it("each user sees only their own rows", async () => {
    const seenByA = await withUser(db, A, (tx) => tx.select().from(accounts));
    const seenByB = await withUser(db, B, (tx) => tx.select().from(accounts));
    expect(seenByA.map((r) => r.userId)).toEqual([A]);
    expect(seenByB.map((r) => r.userId)).toEqual([B]);
    expect(await ownerCount(db, "accounts")).toBe(2);
  });

  it("a query without a WHERE clause still can't see the other user", async () => {
    const rows = await withUser(db, A, (tx) => tx.execute(sql`select user_id from transactions`));
    expect(sqlRows(rows)).toEqual([{ user_id: A }]);
  });

  it("can't read another user's row by id", async () => {
    const [bAcct] = await withUser(db, B, (tx) => tx.select().from(accounts));
    const viaA = await withUser(db, A, (tx) =>
      tx.select().from(accounts).where(eq(accounts.id, bAcct!.id)),
    );
    expect(viaA).toEqual([]);
  });

  it("can't insert rows for another user", async () => {
    await expect(
      withUser(db, A, (tx) =>
        tx.insert(accounts).values({ userId: B, bank: "UOB", kind: "card", productName: "X" }),
      ),
    ).rejects.toThrow();
  });

  it("can't update or delete another user's rows (silently affects 0 rows)", async () => {
    const updated = await withUser(db, A, (tx) =>
      tx
        .update(accounts)
        .set({ productName: "HIJACKED" })
        .where(eq(accounts.userId, B))
        .returning(),
    );
    const deleted = await withUser(db, A, (tx) =>
      tx.delete(transactions).where(eq(transactions.userId, B)).returning(),
    );
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    const [bAcct] = await withUser(db, B, (tx) => tx.select().from(accounts));
    expect(bAcct!.productName).toBe("UOB SAMPLE CASHBACK");
  });

  it("can't move a row to another user", async () => {
    await expect(
      withUser(db, A, (tx) => tx.update(accounts).set({ userId: B }).where(eq(accounts.userId, A))),
    ).rejects.toThrow();
  });

  it("sees nothing when app.user_id is unset", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      return tx.execute(sql`select count(*)::int as n from accounts`);
    });
    expect(sqlRows(rows)).toEqual([{ n: 0 }]);
  });

  it("app_user can't read Better Auth tables (emails, sessions)", async () => {
    await expect(withUser(db, A, (tx) => tx.select().from(user))).rejects.toThrow();
    await expect(withUser(db, A, (tx) => tx.execute(sql`select * from session`))).rejects.toThrow();
  });

  it("rejects an empty user id", async () => {
    await expect(withUser(db, "", async () => 1)).rejects.toThrow(/user id/);
  });

  it("the role switch does not outlive the transaction", async () => {
    await withUser(db, A, (tx) => tx.select().from(accounts));
    const res = await db.execute(
      sql`select current_user as u, current_setting('app.user_id', true) as uid`,
    );
    expect(sqlRows(res)[0]).toMatchObject({ u: "postgres" });
    expect(sqlRows<{ uid: string | null }>(res)[0]!.uid ?? "").toBe("");
  });

  it("every user table has RLS enabled, a policy for app_user, and grants", async () => {
    const res = await db.execute(sql`
      select c.relname as t, c.relrowsecurity as rls,
        exists (select 1 from pg_policies p where p.tablename = c.relname and 'app_user' = any(p.roles)) as policy,
        has_table_privilege('app_user', c.oid, 'SELECT') as can_select
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`);
    const byTable = new Map(
      sqlRows<{ t: string } & Record<string, boolean>>(res).map((r) => [r.t, r]),
    );
    for (const t of USER_TABLES) {
      expect(byTable.get(t), t).toMatchObject({ rls: true, policy: true, can_select: true });
    }
    // Every table app_user can read is either a user table or the global merchant map.
    const readable = [...byTable.entries()]
      .filter(([, r]) => r.can_select)
      .map(([t]) => t)
      .sort();
    expect(readable).toEqual([...USER_TABLES, "merchant_map"].sort());
  });
});

describe("audit_log is append-only", () => {
  it("allows insert but blocks update and delete, even for the owner", async () => {
    await withUser(db, A, (tx) =>
      tx.insert(auditLog).values({ userId: A, actor: "user", event: "proposed" }),
    );
    await expect(
      withUser(db, A, (tx) =>
        tx.update(auditLog).set({ event: "executed" }).where(eq(auditLog.userId, A)),
      ),
    ).rejects.toThrow();
    expect(
      await pgError(db.update(auditLog).set({ event: "executed" }).where(eq(auditLog.userId, A))),
    ).toMatch(/append-only/);
    expect(await pgError(db.delete(auditLog).where(eq(auditLog.userId, A)))).toMatch(/append-only/);
  });

  it("rows disappear with their user when the account is deleted", async () => {
    const C = await createUser(db, "user-c");
    await withUser(db, C, (tx) =>
      tx.insert(auditLog).values({ userId: C, actor: "user", event: "proposed" }),
    );
    await db.delete(user).where(eq(user.id, C));
    const left = await db.execute(
      sql`select count(*)::int as n from audit_log where user_id = ${C}`,
    );
    expect(sqlRows(left)[0]).toEqual({ n: 0 });
  });
});
