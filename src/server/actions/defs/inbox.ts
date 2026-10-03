import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { alerts, subscriptions } from "@/db/schema";
import type { Tx } from "@/db/with-user";
import { ProposalError } from "../common";
import { register, type Versions } from "../engine";
import { plural } from "./shared";

/** Alerts and subscriptions: your decisions about what the detectors found. */

const alertIds = z.array(z.uuid()).min(1).max(200);
const alertPayload = z.object({ alertIds });

async function alertVersions(tx: Tx, ids: readonly string[], lock: boolean): Promise<Versions> {
  const q = tx
    .select({ id: alerts.id, status: alerts.status })
    .from(alerts)
    .where(inArray(alerts.id, [...ids]))
    .orderBy(alerts.id);
  const rows = lock ? await q.for("update") : await q;
  return Object.fromEntries(rows.map((r) => [`alert:${r.id}`, r.status]));
}

const LABEL: Record<string, string> = {
  price_increase: "price rise",
  trial_conversion: "trial ending",
  unusual_amount: "unusual amount",
  duplicate_charge: "possible duplicate",
  first_time_merchant: "new merchant",
  foreign_charge: "foreign charge",
  card_fee: "card fee",
  bill_due: "bill due",
};

function alertAction(type: "dismiss_alert" | "mark_alert_expected") {
  const to = type === "dismiss_alert" ? "dismissed" : "expected";
  register({
    type,
    input: z.object({ alertIds }),
    payload: alertPayload,
    undoable: true,
    ledger: false,
    async prepare(tx, _userId, input) {
      const rows = await tx
        .select({
          id: alerts.id,
          type: alerts.type,
          status: alerts.status,
          subject: alerts.subject,
        })
        .from(alerts)
        .where(inArray(alerts.id, input.alertIds));
      if (rows.length !== new Set(input.alertIds).size)
        throw new ProposalError("invalid_reference");
      const open = rows.filter((r) => r.status === "open");
      const first = open[0];
      return {
        payload: { alertIds: open.map((r) => r.id) },
        preview: {
          title:
            open.length === 1 && first
              ? `${to === "dismissed" ? "Dismiss" : "Mark as expected"}: ${LABEL[first.type] ?? "alert"}${first.subject ? `, ${first.subject}` : ""}`
              : `${to === "dismissed" ? "Dismiss" : "Mark as expected"} ${plural(open.length, "alert")}`,
          lines: [
            to === "dismissed"
              ? "It moves to Closed alerts."
              : "It moves to Closed alerts, and similar charges are treated as normal.",
          ],
          affected: open.length,
        },
      };
    },
    versions: (tx, p, lock) => alertVersions(tx, p.alertIds, lock),
    async execute(tx, _userId, p) {
      await tx.update(alerts).set({ status: to }).where(inArray(alerts.id, p.alertIds));
      return { result: { closed: p.alertIds.length }, inverse: { status: "open" } };
    },
    async undo(tx, _userId, p) {
      await tx.update(alerts).set({ status: "open" }).where(inArray(alerts.id, p.alertIds));
    },
  });
}
alertAction("dismiss_alert");
alertAction("mark_alert_expected");

const subPayload = z.object({ subscriptionId: z.uuid(), ignored: z.boolean() });

register({
  type: "set_subscription_status",
  /** Ignore a detected subscription, or show it again. */
  input: subPayload,
  payload: subPayload,
  undoable: true,
  ledger: false,
  async prepare(tx, _userId, input) {
    const [s] = await tx
      .select({ merchant: subscriptions.merchantName, ignored: subscriptions.ignored })
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId));
    if (!s) throw new ProposalError("invalid_reference");
    return {
      payload: input,
      preview: {
        title: `${input.ignored ? "Ignore" : "Show again"}: ${s.merchant}`,
        lines: [
          input.ignored
            ? "It leaves your subscription totals; it is still tracked."
            : "It counts in your subscription totals again.",
        ],
        affected: s.ignored === input.ignored ? 0 : 1,
      },
    };
  },
  async versions(tx, p, lock) {
    const q = tx
      .select({ ignored: subscriptions.ignored })
      .from(subscriptions)
      .where(eq(subscriptions.id, p.subscriptionId));
    const [s] = lock ? await q.for("update") : await q;
    return { [`sub:${p.subscriptionId}`]: s ? String(s.ignored) : "missing" };
  },
  async execute(tx, _userId, p) {
    await tx
      .update(subscriptions)
      .set({ ignored: p.ignored, updatedAt: new Date() })
      .where(eq(subscriptions.id, p.subscriptionId));
    return { result: { changed: 1 }, inverse: { ignored: !p.ignored } };
  },
  async undo(tx, _userId, p) {
    await tx
      .update(subscriptions)
      .set({ ignored: !p.ignored, updatedAt: new Date() })
      .where(eq(subscriptions.id, p.subscriptionId));
  },
});
