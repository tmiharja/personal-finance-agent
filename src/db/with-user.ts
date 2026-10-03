import { sql } from "drizzle-orm";
import type { AppDb } from "./client";

export type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

/**
 * The only way app code touches user data. Opens a transaction, pins
 * `app.user_id` to the authenticated user and drops to the `app_user` role, so
 * Postgres Row-Level Security limits every statement to that user's rows, even
 * if a query forgets a WHERE clause. Both settings are LOCAL: they end with the
 * transaction and never leak to a pooled connection.
 *
 * `userId` must come from the server-side session, never from a request body or
 * a model tool call.
 */
export async function withUser<T>(
  db: AppDb,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("withUser requires an authenticated user id");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    await tx.execute(sql`set local role app_user`);
    return fn(tx);
  });
}
