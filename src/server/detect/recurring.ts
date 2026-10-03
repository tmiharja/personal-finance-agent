import { addDays, addMonthsIso, daysBetween, median, type Ledger, type Row } from "./ledger";

/**
 * Recurring charges (PRD DET-1, DET-2, DET-3, DET-6).
 *
 * A subscription is a merchant whose latest run of charges follows one cadence
 * (weekly; monthly ±4 days; quarterly; annual) for at least 3 charges (2 for
 * annual), at no more than two price levels (a single price change; each level
 * within ±10%). A $0–2 charge just before a run is a free trial. Variable
 * recurring payments to utilities, telcos and insurers are bills instead.
 */

export type Cadence = "weekly" | "monthly" | "quarterly" | "annual";

export const PER_MONTH: Record<Cadence, number> = {
  weekly: 52 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  annual: 1 / 12,
};

const CADENCES: {
  cadence: Cadence;
  next: (iso: string) => string;
  tolerance: number;
  min: number;
}[] = [
  { cadence: "monthly", next: (d) => addMonthsIso(d, 1), tolerance: 4, min: 3 },
  { cadence: "weekly", next: (d) => addDays(d, 7), tolerance: 1, min: 3 },
  { cadence: "quarterly", next: (d) => addMonthsIso(d, 3), tolerance: 7, min: 3 },
  { cadence: "annual", next: (d) => addMonthsIso(d, 12), tolerance: 10, min: 2 },
];

export const BILL_CATEGORIES = new Set(["Bills & Utilities", "Telco & Internet", "Insurance"]);
const BILL_PAYEE = /\b(TOWN COUNCIL|MCST|IRAS|LOAN|CONSERVANCY)\b/i;
export const TRIAL_MAX_CENTS = 200;
const LEVEL_TOLERANCE = 0.1;
const PRICE_RISE = 0.05;
/** Charges within 1% of the latest count as the same (current) price. */
const SAME_PRICE = 0.01;

export type Subscription = {
  key: string;
  merchant: string;
  cadence: Cadence;
  amountCents: number;
  monthlyCents: number;
  charges: number;
  firstChargeDate: string;
  lastChargeDate: string;
  nextExpectedDate: string;
  status: "active" | "overdue" | "possibly_cancelled";
  previousAmountCents: number | null;
  priceChangedOn: string | null;
  card: string;
  /** The rows in the series, oldest first. */
  ids: string[];
  trial: { id: string; date: string; amountCents: number } | null;
};

export type Bill = {
  payee: string;
  accountId: string;
  card: string;
  dueDay: number;
  nextDueDate: string;
  expectedAmountCents: number;
  lastAmountCents: number;
  lastPaidOn: string;
  status: "upcoming" | "paid" | "overdue";
};

/** Splits amounts (oldest first) into consecutive price levels, each within ±10% of its first. */
function levels(amounts: readonly number[]): number[][] {
  const out: number[][] = [];
  for (const a of amounts) {
    const cur = out.at(-1);
    if (cur && Math.abs(a - cur[0]!) <= cur[0]! * LEVEL_TOLERANCE) cur.push(a);
    else out.push([a]);
  }
  return out;
}

/**
 * The latest price change in a series (oldest first): where the trailing run at
 * the current price starts, and the median price before it, when the two differ
 * by more than 5%. Independent of the ±10% grouping, so a 5–10% rise is seen.
 */
function priceChange(amounts: readonly number[]): { at: number; previous: number } | null {
  const last = amounts.at(-1)!;
  let at = amounts.length - 1;
  while (at > 0 && Math.abs(amounts[at - 1]! - last) <= last * SAME_PRICE) at--;
  if (at === 0) return null;
  const previous = median(amounts.slice(0, at));
  return Math.abs(last - previous) > previous * PRICE_RISE ? { at, previous } : null;
}

/** The longest run, ending at the latest charge, where each charge follows the cadence. */
function latestRun(charges: Row[], step: (iso: string) => string, tolerance: number): Row[] {
  const run = [charges.at(-1)!];
  for (let i = charges.length - 2; i >= 0; i--) {
    const expected = step(charges[i]!.date);
    if (Math.abs(daysBetween(expected, run[0]!.date)) <= tolerance) run.unshift(charges[i]!);
    else break;
  }
  return run;
}

function statusAt(next: string, reference: string, cadence: Cadence): Subscription["status"] {
  const late = daysBetween(next, reference);
  if (late <= 4) return "active";
  const period =
    cadence === "weekly" ? 7 : cadence === "monthly" ? 31 : cadence === "quarterly" ? 92 : 366;
  return late <= period ? "overdue" : "possibly_cancelled";
}

function byMerchant(rows: readonly Row[]): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    // Transfers between your own accounts, and to or from people, are not merchants.
    if (r.kind !== "charge" || r.amountCents <= 0 || r.isTransfer || PERSON_TRANSFER.test(r.key))
      continue;
    const list = groups.get(r.key) ?? [];
    list.push(r);
    groups.set(r.key, list);
  }
  return groups;
}

const PERSON_TRANSFER = /^(paynow|fast|funds) transfer$/;

const isBillLike = (r: Row) => BILL_CATEGORIES.has(r.category) || BILL_PAYEE.test(r.merchant);

export function detectSubscriptions(ledger: Ledger): Subscription[] {
  const out: Subscription[] = [];
  for (const [key, all] of byMerchant(ledger.rows)) {
    if (all.length < 2 || isBillLike(all.at(-1)!)) continue;
    for (const c of CADENCES) {
      // A trial charge can't be part of the paid series.
      const paid = all.filter((r) => r.amountCents > TRIAL_MAX_CENTS);
      if (paid.length < c.min) continue;
      const run = latestRun(paid, c.next, c.tolerance);
      if (run.length < c.min) continue;
      const lv = levels(run.map((r) => r.amountCents));
      // At most one price change, and the new price must hold (no flip-flopping).
      if (lv.length > 2) continue;
      const last = run.at(-1)!;
      const before = all.filter((r) => r.date < run[0]!.date);
      const prior = before.at(-1);
      const trial =
        prior &&
        prior.amountCents <= TRIAL_MAX_CENTS &&
        daysBetween(prior.date, run[0]!.date) >= 3 &&
        daysBetween(prior.date, run[0]!.date) <= 35
          ? { id: prior.id, date: prior.date, amountCents: prior.amountCents }
          : null;
      const nextExpected = c.next(last.date);
      const reference = ledger.coverage.get(last.accountId) ?? last.date;
      const change = priceChange(run.map((r) => r.amountCents));
      out.push({
        key,
        merchant: last.merchant,
        cadence: c.cadence,
        amountCents: last.amountCents,
        monthlyCents: Math.round(last.amountCents * PER_MONTH[c.cadence]),
        charges: run.length,
        firstChargeDate: run[0]!.date,
        lastChargeDate: last.date,
        nextExpectedDate: nextExpected,
        status: statusAt(nextExpected, reference, c.cadence),
        previousAmountCents: change ? change.previous : null,
        priceChangedOn: change ? run[change.at]!.date : null,
        card: last.card,
        ids: run.map((r) => r.id),
        trial,
      });
      break;
    }
  }
  return out.sort((a, b) => b.monthlyCents - a.monthlyCents);
}

/** DET-2: the new price is more than 5% above the old one. */
export const isPriceRise = (s: Subscription) =>
  s.previousAmountCents !== null && s.amountCents > s.previousAmountCents * (1 + PRICE_RISE);

/** DET-6: monthly payments to bill-like payees, whatever the amount. */
export function detectBills(ledger: Ledger): Bill[] {
  const out: Bill[] = [];
  for (const [, all] of byMerchant(ledger.rows)) {
    const last = all.at(-1)!;
    if (!isBillLike(last) || all.length < 3) continue;
    const run = latestRun(all, (d) => addMonthsIso(d, 1), 8);
    if (run.length < 3) continue;
    const dueDay = median(run.map((r) => Number(r.date.slice(8, 10))));
    const nextDue = addMonthsIso(last.date, 1);
    const reference = ledger.coverage.get(last.accountId) ?? last.date;
    const late = daysBetween(nextDue, reference);
    out.push({
      payee: last.merchant,
      accountId: last.accountId,
      card: last.card,
      dueDay,
      nextDueDate: nextDue,
      expectedAmountCents: median(run.slice(-3).map((r) => r.amountCents)),
      lastAmountCents: last.amountCents,
      lastPaidOn: last.date,
      status: late > 5 ? "overdue" : "upcoming",
    });
  }
  return out.sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
}
