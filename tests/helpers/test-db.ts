import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import * as schema from "@/db/schema";
import { sqlRows } from "@/db/rows";

/** A fresh in-process Postgres with every migration applied (RLS, grants, triggers). */
export async function createTestDb(): Promise<{ db: AppDb; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  return { db: db as unknown as AppDb, close: () => client.close() };
}

/** Creates a Better Auth user row directly (as the owner role, like Better Auth does). */
export async function createUser(db: AppDb, id: string, email = `${id}@example.com`) {
  await db.insert(schema.user).values({ id, name: id, email, emailVerified: true });
  return id;
}

/** Runs SQL as the owner (bypasses RLS) — for assertions only. */
export async function ownerCount(db: AppDb, table: string): Promise<number> {
  const res = await db.execute(sql.raw(`select count(*)::int as n from "${table}"`));
  return sqlRows<{ n: number }>(res)[0]!.n;
}
