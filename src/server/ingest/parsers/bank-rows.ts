import type { ParsedRow } from "./types";

/**
 * Bank-account rows (PRD IMP-10, §7.1a): a transaction type ("FAST Payment",
 * "NETS QR", "GIRO") plus detail lines → the row's kind and a descriptor that
 * is safe to store. Shared by the DBS/POSB and UOB parsers, PDF and CSV.
 *
 * Other people's names never leave this function. PayNow, FAST and funds
 * transfers to or from a person become "PAYNOW TRANSFER OUT" (direction and
 * amount only). A payee with a company suffix (PTE LTD, LLP, TOWN COUNCIL…) is a
 * merchant and is kept. Rows of an unrecognised type keep only their type line
 * and any company names, since free-text details may name a person.
 */

export type BankRowInput = {
  /** The transaction type as printed, e.g. "FAST Payment / Receipt". */
  type: string;
  /** Detail lines under the type (merchant, payee, references). */
  details: readonly string[];
  /** Signed like every row: + money out (withdrawal), − money in (deposit). */
  cents: number;
};

export type BankRow = { rawDescriptor: string; kind: ParsedRow["kind"] };

const COMPANY =
  /\b(PTE\.? ?LTD\.?|PRIVATE LIMITED|LTD\.?|LIMITED|LLP|LLC|INC\.?|CORP(ORATION)?|SDN\.? BHD\.?|PLC|TOWN COUNCIL|MCST|IRAS|CPF BOARD|HDB|MINISTRY|AUTHORITY|SOCIETY|FOUNDATION|UNIVERSITY|HOSPITAL|INSURANCE|ASSURANCE)\b/i;

const CARD_ISSUER =
  /\b(DBS|POSB|UOB|OCBC|CITI(BANK)?|HSBC|SCB|STANDARD CHARTERED|MAYBANK|AMEX|AMERICAN EXPRESS|TRUST)\b/i;
const CARD_PAYMENT =
  /\b(CARD ?CENT(RE|ER)|CREDIT CARDS?|CARD PAYMENT|CARDS? BILL|BILL PAYMENT\b.*\bCARDS?|GIRO\b.*\bCARDS?|AUTOPAY\b.*\bCARDS?)\b/i;
const SALARY = /\b(SALARY|PAYROLL|SAL CR|SALARY CREDIT|BONUS)\b|^SAL\b/i;
const INTEREST = /\b(INTEREST|BONUS INT|INT\.? CREDIT|INT EARNED)\b/i;
const OWN_TRANSFER = /\b(OWN (A\/C|ACCOUNTS?)|BETWEEN (YOUR |MY )?OWN|TO MY ACCOUNT)\b/i;
const PERSON_TRANSFER =
  /\b(PAYNOW|FAST|FUNDS? TRANSFER|FUNDS? TRF|FUND TRF|IBG|INWARD CREDIT|TRF|TRANSFER|I-BANK)\b/i;
const ATM = /\b(ATM|CASH WITHDRAWAL|CASH WDL|AWL)\b/i;
const FEE = /\b(SERVICE CHARGE|FALL.?BELOW|ACCOUNT FEE|ANNUAL FEE|COMMISSION|HANDLING FEE)\b/i;
const REFUND = /\b(REVERSAL|REFUND|REVERSED)\b/i;
const CASHBACK = /\b(CASHBACK|CASH REBATE|REBATE)\b/i;
const GIRO = /\bGIRO\b/i;
const PURCHASE =
  /\b(NETS( QR)?|POS|POINT-OF-SALE|DEBIT CARD|VISA DEBIT|MASTERCARD DEBIT|DEBIT PURCHASE)\b/i;

/** Type words that prefix a merchant on purchase rows, stripped so the merchant map matches. */
const PURCHASE_PREFIX =
  /^(NETS QR( PAYMENT)?|NETS( DEBIT| PURCHASE)?|POS|POINT-OF-SALE TRANSACTION|DEBIT CARD TRANSACTION|VISA DEBIT|MASTERCARD DEBIT|DEBIT PURCHASE)\s*[-:]?\s*/i;

/** References and card numbers on detail lines: never part of a merchant name. */
const NOISE =
  /^(REF(ERENCE)?( NO\.?)?[: ]|[A-Z]{0,4}\d{6,}$|\d[\d -]{11,}\d$|OTHR\b|SG\s*$|SGD\s*[\d,.]+$)/i;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function companies(lines: readonly string[]): string[] {
  return lines.map(clean).filter((l) => COMPANY.test(l) && !NOISE.test(l));
}

/** The merchant on a purchase row: the first detail line that isn't a reference. */
function merchant(input: BankRowInput): string {
  const lines = [input.type, ...input.details].map((l) => clean(l.replace(PURCHASE_PREFIX, "")));
  return lines.find((l) => l && !NOISE.test(l) && !PURCHASE.test(l)) ?? clean(input.type);
}

/** Counterparty without a company suffix → a person: drop the name, keep the direction. */
function transfer(input: BankRowInput, out: boolean): string {
  const text = `${input.type} ${input.details.join(" ")}`;
  const via = /PAYNOW/i.test(text) ? "PAYNOW" : /FAST/i.test(text) ? "FAST" : "FUNDS";
  const company = companies(input.details)[0];
  if (company) return `${via} ${out ? "TO" : "FROM"} ${stripPrefix(company)}`;
  return `${via} TRANSFER ${out ? "OUT" : "IN"}`;
}

/** "TO SAMPLE PROPERTY PTE LTD" → "SAMPLE PROPERTY PTE LTD". */
const stripPrefix = (s: string) => s.replace(/^(TO|FROM|OTHR|PAYNOW TO|PAYNOW FROM)\s+/i, "");

export function bankRow(input: BankRowInput): BankRow {
  const out = input.cents > 0;
  const text = clean(`${input.type} ${input.details.join(" ")}`);

  if (out && CARD_PAYMENT.test(text)) {
    const issuer = CARD_ISSUER.exec(text)?.[1]?.toUpperCase() ?? "";
    return { kind: "card_payment", rawDescriptor: clean(`CARD PAYMENT ${issuer} CARD`) };
  }
  if (!out && SALARY.test(text)) {
    const employer = companies(input.details)[0];
    return {
      kind: "income",
      rawDescriptor: employer ? `SALARY ${stripPrefix(employer)}` : "SALARY",
    };
  }
  if (!out && INTEREST.test(text)) return { kind: "income", rawDescriptor: "INTEREST CREDIT" };
  if (OWN_TRANSFER.test(text)) {
    return { kind: "transfer", rawDescriptor: `TRANSFER ${out ? "TO" : "FROM"} OWN ACCOUNT` };
  }
  if (out && ATM.test(text)) return { kind: "charge", rawDescriptor: "CASH WITHDRAWAL ATM" };
  if (out && FEE.test(text)) return { kind: "fee", rawDescriptor: clean(input.type).toUpperCase() };
  if (!out && CASHBACK.test(text)) return { kind: "cashback", rawDescriptor: merchant(input) };
  if (!out && REFUND.test(text)) return { kind: "refund", rawDescriptor: merchant(input) };
  if (PERSON_TRANSFER.test(text) && !GIRO.test(input.type)) {
    return { kind: out ? "charge" : "income", rawDescriptor: transfer(input, out) };
  }
  if (out && GIRO.test(text)) {
    const payee = companies(input.details)[0];
    return { kind: "charge", rawDescriptor: payee ? stripPrefix(payee) : "GIRO PAYMENT" };
  }
  if (out && PURCHASE.test(text)) return { kind: "charge", rawDescriptor: merchant(input) };
  // Unrecognised: the type line, plus company names only (details may name a person).
  const company = companies(input.details)[0];
  return {
    kind: out ? "charge" : "income",
    rawDescriptor: clean(`${input.type}${company ? ` ${stripPrefix(company)}` : ""}`).toUpperCase(),
  };
}
