import { eq } from "drizzle-orm";
import { userKeys } from "@/db/schema";
import type { Tx } from "@/db/with-user";
import { generateDek, unwrapDek, UserCrypto, wrapDek, type MasterKeys } from "./envelope";

/**
 * Loads (or creates on first use) the user's data key inside a withUser()
 * transaction. A key wrapped under the previous master key is re-wrapped under
 * the current one, so rotation completes as users come back.
 */
export async function getUserCrypto(tx: Tx, userId: string, keys: MasterKeys): Promise<UserCrypto> {
  const [row] = await tx.select().from(userKeys).where(eq(userKeys.userId, userId));
  if (!row) {
    const dek = generateDek();
    const { wrapped, masterKeyId } = wrapDek(dek, userId, keys);
    await tx.insert(userKeys).values({ userId, wrappedDek: wrapped, masterKeyId });
    return new UserCrypto(dek, userId);
  }
  const dek = unwrapDek(row.wrappedDek, userId, keys);
  if (row.masterKeyId !== keys.current.id) {
    const { wrapped, masterKeyId } = wrapDek(dek, userId, keys);
    await tx
      .update(userKeys)
      .set({ wrappedDek: wrapped, masterKeyId })
      .where(eq(userKeys.userId, userId));
  }
  return new UserCrypto(dek, userId);
}
