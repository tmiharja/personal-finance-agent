import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { alerts, proposedActions } from "@/db/schema";
import { withUser } from "@/db/with-user";
import type { MasterKeys } from "@/server/crypto/envelope";
import { ProposalError } from "./common";
import { undoAction } from "./index";

/**
 * "Reopen" on a closed alert undoes the decision that closed it, so the
 * history shows the dismissal and its undo. An alert closed more than 30 days
 * ago (or before decisions were audited) is reopened directly.
 */
export async function reopenAlert(db: AppDb, userId: string, keys: MasterKeys, alertId: string) {
  const [closing] = await withUser(db, userId, (tx) =>
    tx
      .select({ id: proposedActions.id })
      .from(proposedActions)
      .where(
        and(
          inArray(proposedActions.type, ["dismiss_alert", "mark_alert_expected"]),
          eq(proposedActions.status, "executed"),
          isNull(proposedActions.undoneAt),
          sql`${proposedActions.payload}->'alertIds' @> ${JSON.stringify([alertId])}::jsonb`,
        ),
      )
      .orderBy(desc(proposedActions.executedAt))
      .limit(1),
  );
  if (closing) {
    try {
      return await undoAction(db, userId, keys, closing.id);
    } catch (e) {
      if (!(e instanceof ProposalError && e.code === "undo_expired")) throw e;
    }
  }
  const reopened = await withUser(db, userId, (tx) =>
    tx
      .update(alerts)
      .set({ status: "open" })
      .where(eq(alerts.id, alertId))
      .returning({ id: alerts.id }),
  );
  if (!reopened.length) throw new ProposalError("invalid_reference");
}
