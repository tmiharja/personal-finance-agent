import { money, longDate, monthLabel } from "@/lib/format";
import { daysBetween, median, percentile, type Ledger, type Row } from "./ledger";
import { isPriceRise, TRIAL_MAX_CENTS, type Subscription } from "./recurring";

/**
 * One-off findings (PRD DET-2…DET-5, DET-7). Each alert's reason is plain text
 * built from structured data (never model text, never colour alone), with the
 * figures behind it in `details`. The dedupe key makes every run idempotent.
 */

export type AlertType =
  | "price_increase"
  | "trial_conversion"
  | "unusual_amount"
  | "first_time_merchant"
  | "duplicate_charge"
  | "foreign_charge"
  | "card_fee"
  | "bill_due";

export type DetectedAlert = {
  type: AlertType;
  dedupeKey: string;
  subject: string;
  occurredOn: string;
  reason: string;
  transactionIds: string[];
  details: Record<string, string | number | null>;
};

export const FIRST_TIME_MIN_CENTS = 20_000;
/**
 * Noise floor on DET-4(a): a charge must also be at least S$100 above usual.
 * Without it, merchants with naturally varied baskets (online marketplaces)
 * raise alerts for ordinary orders.
 */
export const UNUSUAL_MIN_EXCESS_CENTS = 10_000;
/** Typical SG card FX fee, for the estimate shown with foreign charges. */
export const FX_FEE_RATE = 0.0325;
const WARM_UP_DAYS = 30;
const MICRO = new Set(["Transport", "Dining"]);
const MICRO_MAX_CENTS = 2_000;

const pct = (a: number, b: number) => Math.round(((a - b) / b) * 100);

function charges(rows: readonly Row[]): Row[] {
  return rows.filter((r) => r.kind === "charge" && r.amountCents > 0);
}

export function priceAlerts(subs: readonly Subscription[]): DetectedAlert[] {
  const out: DetectedAlert[] = [];
  for (const s of subs) {
    if (isPriceRise(s)) {
      const from = s.previousAmountCents!;
      out.push({
        type: "price_increase",
        dedupeKey: `price_increase|${s.key}|${s.priceChangedOn}`,
        subject: s.merchant,
        occurredOn: s.priceChangedOn!,
        reason: `${s.merchant} went from ${money(from)} to ${money(s.amountCents)} (+${pct(s.amountCents, from)}%) from ${longDate(s.priceChangedOn!)}.`,
        transactionIds: s.ids.slice(-3),
        details: {
          fromCents: from,
          toCents: s.amountCents,
          changePct: pct(s.amountCents, from),
          cadence: s.cadence,
        },
      });
    }
  }
  return out;
}

/**
 * DET-3: a $0–2 trial followed by a full-price charge 3–35 days later. For a
 * merchant categorised as a subscription it's raised on the first paid charge;
 * otherwise once the paid charges form a recurring series. One alert per trial
 * (the dedupe key is the merchant and the trial date), refreshed as it firms up.
 */
export function trialAlerts(ledger: Ledger, subs: readonly Subscription[]): DetectedAlert[] {
  const out = new Map<string, DetectedAlert>();
  const add = (
    key: string,
    merchant: string,
    trial: { id: string; date: string; amountCents: number },
    paid: { id: string; date: string; amountCents: number },
    cadence: string | null,
  ) => {
    const dedupeKey = `trial_conversion|${key}|${trial.date}`;
    out.set(dedupeKey, {
      type: "trial_conversion",
      dedupeKey,
      subject: merchant,
      occurredOn: paid.date,
      reason: cadence
        ? `A ${money(trial.amountCents)} trial at ${merchant} on ${longDate(trial.date)} became a ${cadence} charge of ${money(paid.amountCents)} from ${longDate(paid.date)}.`
        : `A ${money(trial.amountCents)} trial at ${merchant} on ${longDate(trial.date)} was followed by a charge of ${money(paid.amountCents)} on ${longDate(paid.date)}.`,
      transactionIds: [trial.id, paid.id],
      details: { trialCents: trial.amountCents, priceCents: paid.amountCents, cadence },
    });
  };
  const byKey = new Map<string, Row[]>();
  for (const r of charges(ledger.rows)) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  for (const [key, [first, next]] of byKey) {
    if (!first || !next || first.amountCents > TRIAL_MAX_CENTS) continue;
    if (next.amountCents <= TRIAL_MAX_CENTS) continue;
    if (first.category !== "Subscriptions" && next.category !== "Subscriptions") continue;
    const gap = daysBetween(first.date, next.date);
    if (gap >= 3 && gap <= 35) add(key, next.merchant, first, next, null);
  }
  for (const s of subs) {
    if (!s.trial) continue;
    const paid = ledger.rows.find((r) => r.id === s.ids[0])!;
    add(s.key, s.merchant, s.trial, paid, s.cadence);
  }
  return [...out.values()];
}

/** DET-4 (a) unusual amount, (b) first-time merchant, (c) duplicates. */
export function chargeAlerts(
  ledger: Ledger,
  subscriptionKeys: ReadonlySet<string>,
): DetectedAlert[] {
  const out: DetectedAlert[] = [];
  const all = charges(ledger.rows);
  if (!all.length) return out;
  const firstDay = all[0]!.date;
  const seen = new Map<string, Row[]>();

  for (const r of all) {
    const prior = seen.get(r.key) ?? [];
    // (a) much larger than usual at a regular merchant.
    if (prior.length >= 3) {
      const amounts = prior.map((p) => p.amountCents);
      const usual = median(amounts);
      const threshold = Math.max(3 * usual, percentile(amounts, 95));
      if (
        r.amountCents > threshold &&
        r.amountCents - usual >= UNUSUAL_MIN_EXCESS_CENTS &&
        !subscriptionKeys.has(r.key)
      ) {
        out.push({
          type: "unusual_amount",
          dedupeKey: `unusual_amount|${r.id}`,
          subject: r.merchant,
          occurredOn: r.date,
          reason: `${money(r.amountCents)} at ${r.merchant} on ${longDate(r.date)} is over ${Math.floor(r.amountCents / usual)}× your usual (${money(usual)}).`,
          transactionIds: [r.id],
          details: { amountCents: r.amountCents, usualCents: usual, priorCharges: prior.length },
        });
      }
    }
    // (b) a large first charge at a new merchant, once there's history to compare with.
    if (
      !prior.length &&
      r.amountCents >= FIRST_TIME_MIN_CENTS &&
      daysBetween(firstDay, r.date) >= WARM_UP_DAYS
    ) {
      out.push({
        type: "first_time_merchant",
        dedupeKey: `first_time_merchant|${r.id}`,
        subject: r.merchant,
        occurredOn: r.date,
        reason: `First charge at ${r.merchant}: ${money(r.amountCents)} on ${longDate(r.date)}.`,
        transactionIds: [r.id],
        details: { amountCents: r.amountCents, thresholdCents: FIRST_TIME_MIN_CENTS },
      });
    }
    // (c) the same amount at the same merchant on the same or the next date, so
    // under 48 hours apart (dates carry no time). Not transit/F&B small change.
    const micro = MICRO.has(r.category) && r.amountCents < MICRO_MAX_CENTS;
    const twin = micro
      ? undefined
      : prior.findLast((p) => p.amountCents === r.amountCents && daysBetween(p.date, r.date) <= 1);
    if (twin) {
      out.push({
        type: "duplicate_charge",
        dedupeKey: `duplicate_charge|${twin.id}|${r.id}`,
        subject: r.merchant,
        occurredOn: r.date,
        reason: `Two charges of ${money(r.amountCents)} at ${r.merchant} ${twin.date === r.date ? `on ${longDate(r.date)}` : `on consecutive days (${longDate(twin.date)} and ${longDate(r.date)})`}. If you were charged twice, ask the merchant or your bank to reverse one.`,
        transactionIds: [twin.id, r.id],
        details: { amountCents: r.amountCents },
      });
    }
    prior.push(r);
    seen.set(r.key, prior);
  }
  return out;
}

/** DET-4 (d): foreign-currency spending, one alert per currency per month (subscriptions excepted). */
export function foreignAlerts(
  ledger: Ledger,
  subscriptionKeys: ReadonlySet<string>,
): DetectedAlert[] {
  const groups = new Map<string, Row[]>();
  for (const r of charges(ledger.rows)) {
    if (!r.fxAmount || subscriptionKeys.has(r.key)) continue;
    const k = `${r.fxCurrency ?? "FX"}|${r.date.slice(0, 7)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups].map(([k, rows]) => {
    const [ccy, month] = k.split("|") as [string, string];
    const total = rows.reduce((s, r) => s + r.amountCents, 0);
    const fee = Math.round(total - total / (1 + FX_FEE_RATE));
    return {
      type: "foreign_charge" as const,
      dedupeKey: `foreign_charge|${k}`,
      subject: ccy,
      occurredOn: rows[0]!.date,
      reason: `${rows.length} ${rows.length === 1 ? "charge" : "charges"} in ${ccy} in ${monthLabel(month, "long")}, ${money(total)} in total. Card FX fees (typically about ${(FX_FEE_RATE * 100).toFixed(2)}%, roughly ${money(fee)} here) are included in these amounts.`,
      transactionIds: rows.map((r) => r.id).slice(0, 50),
      details: { currency: ccy, charges: rows.length, totalCents: total, estimatedFeeCents: fee },
    };
  });
}

const FEE_LABEL: readonly [RegExp, string][] = [
  [/ANNUAL FEE/i, "Annual fee"],
  [/LATE/i, "Late payment fee"],
  [/FINANCE|INTEREST/i, "Interest"],
  [/OVERLIMIT|OVER LIMIT/i, "Over-limit fee"],
];

const joinList = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** DET-5: card fees on one card and date are one event (an annual fee and its GST), every fee itemised. */
export function feeAlerts(ledger: Ledger, descriptorOf: (id: string) => string): DetectedAlert[] {
  const groups = new Map<string, Row[]>();
  for (const r of ledger.rows) {
    if (r.kind !== "fee" || r.amountCents <= 0) continue;
    const k = `${r.accountId}|${r.date}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups].map(([k, rows]) => {
    const labelled = rows.map((r) => ({
      r,
      label:
        FEE_LABEL.find(([re]) => re.test(descriptorOf(r.id)))?.[1] ??
        (/GST/i.test(descriptorOf(r.id)) ? "GST" : "Fee"),
    }));
    const fees = labelled.filter((l) => l.label !== "GST");
    const gst = fees.length ? labelled.filter((l) => l.label === "GST") : [];
    const main = fees.length ? fees : labelled;
    const sum = (ls: typeof labelled) => ls.reduce((s, l) => s + l.r.amountCents, 0);
    const items = main.map(
      (l, i) => `${i ? l.label.toLowerCase() : l.label} of ${money(l.r.amountCents)}`,
    );
    const total = rows.reduce((s, r) => s + r.amountCents, 0);
    const waiver = main.some((l) => l.label === "Annual fee" || l.label === "Late payment fee");
    return {
      type: "card_fee" as const,
      dedupeKey: `card_fee|${k}`,
      subject: rows[0]!.card,
      occurredOn: rows[0]!.date,
      reason:
        `${joinList(items)}${gst.length ? ` plus GST of ${money(sum(gst))}` : ""} on ${rows[0]!.card} (${longDate(rows[0]!.date)}).` +
        (waiver ? " Singapore banks often waive this if you ask." : ""),
      transactionIds: rows.map((r) => r.id),
      details: {
        feeCents: sum(main),
        gstCents: sum(gst),
        totalCents: total,
        kind: main.map((l) => l.label).join(", "),
      },
    };
  });
}

/** How long after a missed due date the alert stays (older statements are history, not news). */
const DUE_GRACE_DAYS = 7;

/**
 * DET-7: a card payment due within 3 days of today, or missed in the last week,
 * with no payment recorded since the statement. The alert is retired once a
 * payment or a newer statement arrives (see runDetectorsTx).
 */
export function dueAlerts(ledger: Ledger, today: string): DetectedAlert[] {
  const latest = new Map<string, Ledger["statements"][number]>();
  for (const s of ledger.statements) latest.set(s.accountId, s);
  const out: DetectedAlert[] = [];
  for (const s of latest.values()) {
    if (!s.dueDate || s.totalCents <= 0) continue;
    const days = daysBetween(today, s.dueDate);
    if (days < -DUE_GRACE_DAYS || days > 3) continue;
    const paid = ledger.rows.some(
      (r) => r.accountId === s.accountId && r.kind === "card_payment" && r.date > s.statementDate,
    );
    if (paid) continue;
    out.push({
      type: "bill_due",
      dedupeKey: `bill_due|${s.accountId}|${s.dueDate}`,
      subject: s.card,
      occurredOn: s.dueDate,
      reason: `${s.card}: ${money(s.totalCents)} ${days < 0 ? `was due on ${longDate(s.dueDate)}` : `due ${days === 0 ? "today" : days === 1 ? "tomorrow" : `on ${longDate(s.dueDate)}`}`} (minimum ${money(s.minimumPaymentCents ?? 0)}). No payment recorded since the ${longDate(s.statementDate)} statement.`,
      transactionIds: [],
      details: {
        totalCents: s.totalCents,
        minimumCents: s.minimumPaymentCents ?? 0,
        dueDate: s.dueDate,
      },
    });
  }
  return out;
}
