import { eq, ne } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { userKeys } from "@/db/schema";
import type { Tx } from "@/db/with-user";
import { generateDek, unwrapDek, UserCrypto, wrapDek, type MasterKeys } from "./envelope";

/**
 * Loads (or creates on first use) the user's data key inside a withUser()
 * transaction. Creation is race-safe: concurrent first requests all insert-or-
 * ignore, then read back the one stored row, so every caller uses the same key.
 * A key wrapped under the previous master key is re-wrapped under the current one.
 */
export async function getUserCrypto(tx: Tx, userId: string, keys: MasterKeys): Promise<UserCrypto> {
  const { wrapped, masterKeyId } = wrapDek(generateDek(), userId, keys);
  await tx
    .insert(userKeys)
    .values({ userId, wrappedDek: wrapped, masterKeyId })
    .onConflictDoNothing();
  const [row] = await tx.select().from(userKeys).where(eq(userKeys.userId, userId));
  if (!row) throw new Error("user key missing after insert");

  const dek = unwrapDek(row.wrappedDek, userId, keys);
  if (row.masterKeyId !== keys.current.id) {
    const rewrapped = wrapDek(dek, userId, keys);
    await tx
      .update(userKeys)
      .set({ wrappedDek: rewrapped.wrapped, masterKeyId: rewrapped.masterKeyId })
      .where(eq(userKeys.userId, userId));
  }
  return new UserCrypto(dek, userId);
}

/**
 * Completes a master-key rotation for every user, including ones who haven't
 * come back (scripts/rewrap-keys.ts). Runs as the owner role: it touches only
 * wrapped keys, never user data. Only remove MASTER_KEY_PREVIOUS once this
 * reports `remaining: 0`.
 */
export async function rewrapAllUserKeys(
  db: AppDb,
  keys: MasterKeys,
): Promise<{ rewrapped: number; remaining: number }> {
  const stale = await db.select().from(userKeys).where(ne(userKeys.masterKeyId, keys.current.id));
  let rewrapped = 0;
  for (const row of stale) {
    const dek = unwrapDek(row.wrappedDek, row.userId, keys);
    const next = wrapDek(dek, row.userId, keys);
    await db
      .update(userKeys)
      .set({ wrappedDek: next.wrapped, masterKeyId: next.masterKeyId })
      .where(eq(userKeys.userId, row.userId));
    rewrapped++;
  }
  const left = await db.select().from(userKeys).where(ne(userKeys.masterKeyId, keys.current.id));
  return { rewrapped, remaining: left.length };
}
