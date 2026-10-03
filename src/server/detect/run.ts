import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { alerts, bills, subscriptions, transactions } from "@/db/schema";
import { withUser, type Tx } from "@/db/with-user";
import { todaySgt } from "@/server/agent/period";
import type { MasterKeys } from "@/server/crypto/envelope";
import { getUserCrypto } from "@/server/crypto/user-keys";
import { logEvent } from "@/server/log";
import { assertNoPii } from "@/server/pii/firewall";
import {
  chargeAlerts,
  dueAlerts,
  feeAlerts,
  foreignAlerts,
  priceAlerts,
  type DetectedAlert,
} from "./alerts";
import { loadLedger } from "./ledger";
import { detectBills, detectSubscriptions } from "./recurring";

/**
 * Runs every detector for one user (PRD DET-9): after a committed import or a
 * rule, and daily by cron. Deterministic and idempotent: subscriptions and
 * bills are refreshed in place, alerts are inserted once per dedupe key, and
 * an alert you dismissed is never reopened.
 */

export type DetectResult = { subscriptions: number; bills: number; newAlerts: number };

export async function runDetectorsTx(
  tx: Tx,
  userId: string,
  keys: MasterKeys,
  today = todaySgt(),
): Promise<DetectResult> {
  const ledger = await loadLedger(tx);
  const subs = detectSubscriptions(ledger);
  const subKeys = new Set(subs.map((s) => s.key));
  const found = detectBills(ledger);

  // Fee labels need the descriptor ("ANNUAL FEE" vs "GST @ 9%"); decrypt only those rows.
  const feeIds = ledger.rows.filter((r) => r.kind === "fee").map((r) => r.id);
  const descriptors = new Map<string, string>();
  if (feeIds.length) {
    const crypto = await getUserCrypto(tx, userId, keys);
    const enc = await tx
      .select({ id: transactions.id, d: transactions.descriptorEnc })
      .from(transactions)
      .where(inArray(transactions.id, feeIds));
    for (const e of enc) descriptors.set(e.id, crypto.decrypt("transactions.descriptor", e.d));
  }

  const detected: DetectedAlert[] = [
    ...priceAlerts(subs),
    ...chargeAlerts(ledger, subKeys),
    ...foreignAlerts(ledger, subKeys),
    ...feeAlerts(ledger, (id) => descriptors.get(id) ?? ""),
    ...dueAlerts(ledger, today),
  ];

  // Subscriptions: refresh the detected set; drop ones no longer detected unless ignored.
  for (const s of subs) {
    const values = {
      merchantName: s.merchant,
      cadence: s.cadence,
      amountCents: s.amountCents,
      lastChargeDate: s.lastChargeDate,
      nextExpectedDate: s.nextExpectedDate,
      status: s.status,
      charges: s.charges,
      firstChargeDate: s.firstChargeDate,
      previousAmountCents: s.previousAmountCents,
      priceChangedOn: s.priceChangedOn,
      updatedAt: new Date(),
    };
    await tx
      .insert(subscriptions)
      .values({ userId, ...values })
      .onConflictDoUpdate({
        target: [subscriptions.userId, subscriptions.merchantName, subscriptions.cadence],
        set: values,
      });
  }
  await tx.delete(subscriptions).where(
    and(
      eq(subscriptions.ignored, false),
      subs.length
        ? notInArray(
            sql`(${subscriptions.merchantName} || '|' || ${subscriptions.cadence})`,
            subs.map((s) => `${s.merchant}|${s.cadence}`),
          )
        : sql`true`,
    ),
  );

  // Detected bills (manual ones are the user's and are left alone).
  for (const b of found) {
    const values = {
      accountId: b.accountId,
      dueDay: b.dueDay,
      dueDate: b.nextDueDate,
      expectedAmountCents: b.expectedAmountCents,
      lastAmountCents: b.lastAmountCents,
      lastPaidOn: b.lastPaidOn,
      status: b.status,
    };
    await tx
      .insert(bills)
      .values({ userId, payee: b.payee, source: "detected", ...values })
      .onConflictDoUpdate({ target: [bills.userId, bills.payee, bills.source], set: values });
  }
  await tx.delete(bills).where(
    and(
      eq(bills.source, "detected"),
      found.length
        ? notInArray(
            bills.payee,
            found.map((b) => b.payee),
          )
        : sql`true`,
    ),
  );

  let newAlerts = 0;
  for (const a of detected) {
    // Reasons are built from sanitised merchant names; checked anyway before storage.
    assertNoPii({ reason: a.reason, subject: a.subject });
    const inserted = await tx
      .insert(alerts)
      .values({
        userId,
        type: a.type,
        reason: a.reason,
        transactionIds: a.transactionIds,
        dedupeKey: a.dedupeKey,
        subject: a.subject,
        occurredOn: a.occurredOn,
        details: a.details,
      })
      .onConflictDoNothing()
      .returning({ id: alerts.id });
    newAlerts += inserted.length;
  }
  return { subscriptions: subs.length, bills: found.length, newAlerts };
}

export async function runDetectors(
  db: AppDb,
  userId: string,
  keys: MasterKeys,
  today?: string,
): Promise<DetectResult> {
  const result = await withUser(db, userId, (tx) => runDetectorsTx(tx, userId, keys, today));
  logEvent("detect.ran", { ...result });
  return result;
}
