import { joinItems, type Line } from "../pdf";
import type { ParsedCard, ParsedRow } from "./types";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export const AMOUNT = /^[\d,]+\.\d{2}$/;

/** "1,234.56" → 123456 cents. */
export function toCents(s: string): number {
  const [whole, frac = "00"] = s.replace(/,/g, "").split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
}

/** "14 Sep 2026" / "13 SEP 2026" → "2026-09-14". */
export function parseFullDate(s: string): string | null {
  const m = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(s.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toUpperCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

/**
 * "08 SEP" has no year: use the statement's year, unless the month is after the
 * statement month, in which case it's the previous year (Dec rows on a Jan statement).
 */
export function inferDate(ddMon: string, statementDate: string): string | null {
  const m = /^(\d{2}) ([A-Z]{3})$/.exec(ddMon.trim().toUpperCase());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!);
  if (month < 0) return null;
  const stYear = Number(statementDate.slice(0, 4));
  const stMonth = Number(statementDate.slice(5, 7)) - 1;
  const year = month > stMonth ? stYear - 1 : stYear;
  return `${year}-${String(month + 1).padStart(2, "0")}-${m[1]}`;
}

/**
 * Splits a line into its left text and a right-aligned amount (with optional
 * "CR"). The amount must sit in the right part of the page, so numbers inside a
 * description or an FX line are never mistaken for the transaction amount.
 */
export function splitAmount(line: Line): { left: string; cents: number | null } {
  const items = [...line.items];
  let credit = false;
  let last = items.at(-1);
  if (last && /^CR$/i.test(last.str.trim())) {
    credit = true;
    items.pop();
    last = items.at(-1);
  }
  if (!last || last.x < line.pageWidth * 0.6) return { left: line.text, cents: null };
  let str = last.str.trim();
  const inlineCr = /^(.*?)\s*CR$/i.exec(str);
  if (inlineCr) {
    credit = true;
    str = inlineCr[1]!;
  }
  // The amount may share an item with preceding text in some generators.
  const tail = /(?:^|\s)([\d,]+\.\d{2})$/.exec(str);
  if (!tail) return { left: line.text, cents: null };
  const cents = toCents(tail[1]!);
  const before = str.slice(0, str.length - tail[1]!.length).trim();
  const leftItems = items.slice(0, -1);
  if (before) leftItems.push({ ...last, str: before });
  return { left: joinItems(leftItems), cents: credit ? -cents : cents };
}

const PAYMENT =
  /^(AUTOPAY|GIRO PAYMENT|PAYMENT\b|BILL PAYMENT|FAST PAYMENT|IBG PAYMENT|PAYMT THRU)/i;
const CASHBACK = /\b(CASHBACK|CASH REBATE|REBATE)\b/i;
const FEE =
  /^(ANNUAL FEE|GST @|LATE (PAYMENT )?(CHARGE|FEE)|FINANCE CHARGE|INTEREST CHARGE|OVERLIMIT FEE|CASH ADVANCE FEE)/i;

export function classify(descriptor: string, cents: number): ParsedRow["kind"] {
  if (cents < 0 && PAYMENT.test(descriptor)) return "card_payment";
  if (cents < 0 && CASHBACK.test(descriptor)) return "cashback";
  if (cents >= 0 && FEE.test(descriptor)) return "fee";
  return cents < 0 ? "refund" : "charge";
}

type CardDraft = Omit<ParsedCard, "ordinal" | "reconciled"> & {
  hasTotal: boolean;
  hasPrevious: boolean;
};

/**
 * Numbers repeated product names (1, 2, … in order of appearance) and checks each
 * card. A card whose printed total wasn't found is never "reconciled": a missing
 * total is unverified, not a verified zero. (A missing previous balance is only a
 * warning: a card's first statement may not print one, and a real non-zero balance
 * that was missed still fails the sum check.)
 */
export function finaliseCards(drafts: CardDraft[]): ParsedCard[] {
  const seen = new Map<string, number>();
  return drafts.map(({ hasTotal, hasPrevious, ...c }) => {
    const ordinal = (seen.get(c.productName) ?? 0) + 1;
    seen.set(c.productName, ordinal);
    void hasPrevious;
    const reconciled =
      hasTotal &&
      c.previousBalanceCents + c.rows.reduce((s, r) => s + r.amountCents, 0) === c.totalCents;
    return { ...c, ordinal, reconciled };
  });
}

/** DBS prints currency names; normalise spacing and dots before lookup. */
const CURRENCY_NAMES: Record<string, string> = {
  "US DOLLAR": "USD",
  "U S DOLLAR": "USD",
  "SINGAPORE DOLLAR": "SGD",
  "HONG KONG DOLLAR": "HKD",
  "AUSTRALIAN DOLLAR": "AUD",
  "NEW ZEALAND DOLLAR": "NZD",
  "CANADIAN DOLLAR": "CAD",
  "TAIWAN DOLLAR": "TWD",
  "NEW TAIWAN DOLLAR": "TWD",
  "BRUNEI DOLLAR": "BND",
  RUPIAH: "IDR",
  "INDONESIAN RUPIAH": "IDR",
  RINGGIT: "MYR",
  "MALAYSIAN RINGGIT": "MYR",
  BAHT: "THB",
  "THAI BAHT": "THB",
  "PHILIPPINE PESO": "PHP",
  DONG: "VND",
  "VIETNAMESE DONG": "VND",
  YEN: "JPY",
  "JAPANESE YEN": "JPY",
  WON: "KRW",
  "KOREAN WON": "KRW",
  YUAN: "CNY",
  "YUAN RENMINBI": "CNY",
  "CHINESE YUAN": "CNY",
  "INDIAN RUPEE": "INR",
  EURO: "EUR",
  "POUND STERLING": "GBP",
  "SWISS FRANC": "CHF",
};

export function currencyFromName(name: string): string | null {
  const key = name.toUpperCase().replace(/\./g, " ").replace(/\s+/g, " ").trim();
  return CURRENCY_NAMES[key] ?? null;
}

/** "150000.00" / "1,700.00" → "150000.00" / "1700.00" */
export const normaliseFxAmount = (s: string) => s.replace(/,/g, "");

/** Descriptor as printed, with column padding collapsed to single spaces. */
export const cleanDescriptor = (s: string) => s.replace(/\s+/g, " ").trim();
