import { bankRow } from "./bank-rows";
import { parseFullDate, toCents } from "./common";
import { ParseError, type ParsedRow, type ParseResult } from "./types";

/**
 * Bank-account CSV exports (docs/statement-formats.md §6). PROVISIONAL, like the
 * account PDFs: modelled on DBS/POSB's "download transaction history" CSV and
 * UOB's transaction history export saved as CSV.
 *
 * Only the named columns are read. The account number in the header is
 * dropped with the rest of the header; the product name is kept.
 */

export const DBS_CSV_VERSION = "dbs-account-csv@1-provisional";
export const UOB_CSV_VERSION = "uob-account-csv@1-provisional";

const MAX_ROWS = 5000;

/** RFC 4180: quoted fields may hold commas, quotes ("") and newlines. */
export function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.map((r) => r.map((x) => x.trim()));
}

const value = (rows: string[][], label: RegExp) =>
  rows.find((r) => label.test(r[0] ?? ""))?.[1] ?? null;
const cents = (s: string | undefined) =>
  s && /\d/.test(s) ? toCents(s.replace(/[^\d.,]/g, "")) : 0;
/** The account number's digits, in memory only (ParseResult.accountRefs); null if none. */
const accountNumber = (s: string) => /([\d-]{6,})\s*$/.exec(s)?.[1]?.replace(/\D/g, "") || null;

/** "Posb Sample Savings Account 000-00000-0" → "POSB SAMPLE SAVINGS ACCOUNT". */
const product = (s: string) =>
  s
    .replace(/\s+[\d-]{6,}\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

function headerIndex(rows: string[][], first: string[]): number {
  return rows.findIndex((r) =>
    first.every((h, i) => (r[i] ?? "").toLowerCase() === h.toLowerCase()),
  );
}

const DBS_HEADER = ["Transaction Date", "Reference", "Debit Amount", "Credit Amount"];
const UOB_HEADER = ["Transaction Date", "Transaction Description", "Withdrawal", "Deposit"];

export function sniffCsv(text: string): "DBS" | "UOB" | null {
  const rows = readCsv(text.slice(0, 4000));
  if (headerIndex(rows, DBS_HEADER) >= 0 && value(rows, /^Account Details For:?$/i)) return "DBS";
  if (headerIndex(rows, UOB_HEADER) >= 0 && value(rows, /^Account (Type|Number):?$/i)) return "UOB";
  return null;
}

/** DBS reference codes → the transaction type printed on the PDF statement. */
const DBS_CODES: Record<string, string> = {
  ICT: "FAST Payment / Receipt",
  ITR: "Funds Transfer",
  BILL: "Bill Payment",
  POS: "Point-of-Sale Transaction",
  MST: "Debit Card Transaction",
  INT: "Interest Earned",
  SAL: "Salary",
  AWL: "ATM Cash Withdrawal",
  IBG: "Interbank GIRO",
};

function row(date: string | null, type: string, details: string[], amount: number): ParsedRow {
  if (!date) throw new ParseError("invalid_output");
  const { kind, rawDescriptor } = bankRow({ type, details, cents: amount });
  return {
    txnDate: date,
    postDate: null,
    amountCents: amount,
    rawDescriptor,
    refNo: null,
    fx: null,
    kind,
  };
}

export function parseDbsCsv(text: string): ParseResult {
  const rows = readCsv(text);
  const h = headerIndex(rows, DBS_HEADER);
  const account = value(rows, /^Account Details For:?$/i);
  const asAt = value(rows, /^Statement as at:?$/i);
  const statementDate = asAt ? parseFullDate(asAt) : null;
  if (h < 0 || !account) throw new ParseError("no_accounts");
  if (!statementDate) throw new ParseError("no_statement_date");
  const ledger = value(rows, /^Ledger Balance:?$/i);
  const body = rows.slice(h + 1).filter((r) => r.length >= 4 && r[0]);
  if (body.length > MAX_ROWS) throw new ParseError("invalid_output");
  const parsed = body.map((r) => {
    const amount = cents(r[2]) - cents(r[3]);
    const code = (r[1] ?? "").trim();
    return row(
      parseFullDate(r[0]!),
      DBS_CODES[code.toUpperCase()] ?? code,
      r.slice(4).filter(Boolean),
      amount,
    );
  });
  return {
    names: [],
    accountRefs: [accountNumber(account)],
    statement: {
      bank: "DBS",
      kind: "deposit",
      parserVersion: DBS_CSV_VERSION,
      statementDate,
      dueDate: null,
      minimumPaymentCents: null,
      statementTotalCents: null,
      totalsMatch: null,
      cards: [
        {
          productName: product(account),
          ordinal: 1,
          // Only the balance "as at" the export is printed: nothing to reconcile against.
          previousBalanceCents: null,
          totalCents: ledger ? -cents(ledger) : null,
          reconciled: null,
          rows: parsed,
        },
      ],
      warnings: ["no_opening_balance"],
    },
  };
}

/** Transaction types that start a UOB description; the rest are details. */
const UOB_TYPES = [
  "GIRO - Salary",
  "GIRO - Bonus",
  "FAST Payment / Receipt",
  "FAST Payment",
  "PayNow Transfer",
  "Funds Transfer",
  "Bill Payment",
  "ATM Cash Withdrawal",
  "Point-of-Sale Transaction",
  "Debit Card Transaction",
  "NETS QR",
  "NETS",
  "Interest Credit",
  "Interest Earned",
  "Inward Credit",
  "Service Charge",
  "GIRO",
];

function splitDescription(desc: string): { type: string; details: string[] } {
  const known = UOB_TYPES.find((t) => desc.toUpperCase().startsWith(t.toUpperCase()));
  const type = known ? desc.slice(0, known.length) : (desc.split(" ")[0] ?? desc);
  const rest = desc.slice(type.length).trim();
  return { type, details: rest ? [rest] : [] };
}

export function parseUobCsv(text: string): ParseResult {
  const rows = readCsv(text);
  const h = headerIndex(rows, UOB_HEADER);
  const account = value(rows, /^Account Type:?$/i);
  const period = value(rows, /^Statement Period:?$/i);
  const end = period ? /(\d{1,2} [A-Za-z]{3} \d{4})\s*$/.exec(period)?.[1] : null;
  const statementDate = end ? parseFullDate(end) : null;
  if (h < 0 || !account) throw new ParseError("no_accounts");
  if (!statementDate) throw new ParseError("no_statement_date");
  const body = rows.slice(h + 1).filter((r) => r.length >= 5 && r[0]);
  if (body.length > MAX_ROWS) throw new ParseError("invalid_output");
  const warnings: string[] = [];

  const parsed: ParsedRow[] = [];
  const balances: number[] = [];
  for (const r of body) {
    const amount = cents(r[2]) - cents(r[3]);
    const { type, details } = splitDescription(r[1] ?? "");
    parsed.push(row(parseFullDate(r[0]!), type, details, amount));
    balances.push(cents(r[4]));
  }
  // The running balance after each row: opening = first balance + first amount.
  let reconciled: boolean | null = null;
  let opening: number | null = null;
  let closing: number | null = null;
  if (parsed.length && body.every((r) => /\d/.test(r[4] ?? ""))) {
    opening = balances[0]! + parsed[0]!.amountCents;
    closing = balances.at(-1)!;
    reconciled = parsed.every((p, i) =>
      i === 0 ? true : balances[i - 1]! - p.amountCents === balances[i],
    );
    if (!reconciled) warnings.push("running_balance_mismatch");
  } else warnings.push("balance_not_found");

  return {
    names: [],
    accountRefs: [accountNumber(value(rows, /^Account Number:?$/i) ?? "")],
    statement: {
      bank: "UOB",
      kind: "deposit",
      parserVersion: UOB_CSV_VERSION,
      statementDate,
      dueDate: null,
      minimumPaymentCents: null,
      statementTotalCents: null,
      totalsMatch: null,
      cards: [
        {
          productName: product(account),
          ordinal: 1,
          previousBalanceCents: opening === null ? null : -opening,
          totalCents: closing === null ? null : -closing,
          reconciled,
          rows: parsed,
        },
      ],
      warnings,
    },
  };
}
