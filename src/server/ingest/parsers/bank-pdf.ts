import type { Line, LineItem } from "../pdf";
import { bankRow } from "./bank-rows";
import { AMOUNT, inferDate, parseFullDate, toCents } from "./common";
import { ParseError, type ParsedCard, type ParsedRow, type ParseResult } from "./types";

/**
 * Bank-account statement PDFs (docs/statement-formats.md §4–5). PROVISIONAL:
 * built against synthetic fixtures in the banks' published layouts, to be
 * confirmed against real samples (which never enter the repository).
 *
 * One engine, two layouts. Amounts are placed in the Withdrawal, Deposit or
 * Balance column by their right edge, measured against the column headers.
 * The first "brought forward" balance is the opening and the last "carried
 * forward" the closing, so page breaks that repeat them are harmless. Detail
 * lines under a row belong to it. The address block is never read, except
 * the account holder's name, which is passed to the PII firewall in memory.
 */

type Layout = {
  bank: "DBS" | "UOB";
  version: string;
  detect: (lines: Line[]) => boolean;
  /** "POSB SAMPLE SAVINGS ACCOUNT  Account No. …" → the product name; the number is dropped. */
  section: RegExp;
  title: RegExp;
  rowDate: (token: string, statementDate: string) => string | null;
  opening: RegExp;
  closing: RegExp;
  /** The end of the transactions (until the next account section). */
  stop: RegExp;
  /** Lines that are never part of a row ("Total" sits before the closing balance on UOB). */
  skip: RegExp;
};

const SKIP_COMMON = /SYNTHETIC|^Page \d+ of \d+$/i;

export const DBS_ACCOUNT_VERSION = "dbs-account-pdf@1-provisional";
export const UOB_ACCOUNT_VERSION = "uob-account-pdf@1-provisional";

const DBS: Layout = {
  bank: "DBS",
  version: DBS_ACCOUNT_VERSION,
  detect: (lines) => {
    const all = lines.map((l) => l.text);
    return (
      all.some((t) => /^CONSOLIDATED STATEMENT$/i.test(t)) &&
      all.some((t) => /Balance Brought Forward/i.test(t)) &&
      all.some((t) => /\b(DBS Bank Ltd|POSB)\b/.test(t))
    );
  },
  section: /^(.+?\bACCOUNT)\s+Account No\.?\s*[\d-]+$/i,
  title: /^CONSOLIDATED STATEMENT$/i,
  rowDate: (t) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  },
  opening: /^Balance Brought Forward$/i,
  closing: /^Balance Carried Forward$/i,
  stop: /^Deposit Insurance Scheme/i,
  skip: /^(Account Summary|Total)$/i,
};

const UOB: Layout = {
  bank: "UOB",
  version: UOB_ACCOUNT_VERSION,
  detect: (lines) => {
    const all = lines.map((l) => l.text);
    return (
      all.some((t) => /United Overseas Bank Limited/i.test(t)) &&
      all.some((t) => /^Statement of Account$/i.test(t)) &&
      all.some((t) => /\bBALANCE B\/F\b/i.test(t))
    );
  },
  section: /^(.+?\bACCOUNT)\s+[\d-]{9,}(?:\s*\(continued\))?$/i,
  title: /^Statement of Account$/i,
  rowDate: (t, statementDate) =>
    /^\d{2} [A-Za-z]{3}$/.test(t) ? inferDate(t, statementDate) : null,
  opening: /^BALANCE B\/F$/i,
  closing: /^BALANCE C\/F$/i,
  stop: /^End of Account Transaction Details/i,
  skip: /^(Account Transaction Details|Total)$/i,
};

export const isDbsAccount = (lines: Line[]) => DBS.detect(lines);
export const isUobAccount = (lines: Line[]) => UOB.detect(lines);
export const parseDbsAccount = (lines: Line[]) => parseAccountPdf(lines, DBS);
export const parseUobAccount = (lines: Line[]) => parseAccountPdf(lines, UOB);

type Columns = { withdrawal: number; deposit: number; balance: number };
const right = (it: LineItem) => it.x + it.width;

function columnsFrom(line: Line): Columns | null {
  const find = (re: RegExp) => line.items.find((it) => re.test(it.str.trim()));
  const w = find(/^Withdrawals?\b/i);
  const d = find(/^Deposits?\b/i);
  const b = find(/^Balance$/i);
  return w && d && b ? { withdrawal: right(w), deposit: right(d), balance: right(b) } : null;
}

/** Which column a right-aligned amount sits in, or null if it's in none. */
function columnOf(it: LineItem, cols: Columns): keyof Columns | null {
  const r = right(it);
  let best: keyof Columns | null = null;
  let gap = 30;
  for (const k of ["withdrawal", "deposit", "balance"] as const) {
    if (Math.abs(cols[k] - r) < gap) {
      gap = Math.abs(cols[k] - r);
      best = k;
    }
  }
  return best;
}

/** The statement date: "Statement Date 31 Mar 2026", or the end of "01 Mar 2026 to 31 Mar 2026". */
function statementDateOf(lines: Line[]): string | null {
  for (const l of lines.filter((x) => x.page === 1)) {
    const range = /(\d{2} [A-Za-z]{3} \d{4}) to (\d{2} [A-Za-z]{3} \d{4})/i.exec(l.text);
    if (range) return parseFullDate(range[2]!);
    if (/Statement Date/i.test(l.text)) {
      const m = /(\d{1,2} [A-Za-z]{3} \d{4})/.exec(l.text);
      if (m) return parseFullDate(m[1]!);
    }
  }
  return null;
}

/** The account holder's name: the first all-caps line after the title (the address block). */
function holderName(lines: Line[], layout: Layout): string[] {
  const i = lines.findIndex((l) => layout.title.test(l.text));
  if (i < 0) return [];
  const next = lines
    .slice(i + 1, i + 4)
    .find((l) => /^[A-Z][A-Z .'-]{2,40}$/.test(l.items[0]?.str ?? ""));
  return next ? [next.items[0]!.str.trim()] : [];
}

type Draft = {
  productName: string;
  opening: number | null;
  closing: number | null;
  rows: { date: string; type: string; details: string[]; cents: number; balance: number | null }[];
};

function parseAccountPdf(lines: Line[], layout: Layout): ParseResult {
  const statementDate = statementDateOf(lines);
  if (!statementDate) throw new ParseError("no_statement_date");
  const warnings: string[] = [];
  const sections: Draft[] = [];
  let current = null as Draft | null;
  let cols = null as Columns | null;
  let row = null as Draft["rows"][number] | null;
  let stopped = false;

  for (const line of lines) {
    const text = line.text.trim();
    if (!text || SKIP_COMMON.test(text)) continue;
    const sec = layout.section.exec(text);
    if (sec) {
      const productName = sec[1]!.replace(/\s+/g, " ").trim().toUpperCase();
      if (current?.productName !== productName) {
        current = { productName, opening: null, closing: null, rows: [] };
        sections.push(current);
      }
      row = null;
      stopped = false;
      continue;
    }
    const header = columnsFrom(line);
    if (header) {
      cols = header;
      row = null;
      continue;
    }
    if (!current || !cols || stopped) continue;

    const amounts = line.items.filter((it) => AMOUNT.test(it.str.trim()));
    const words = line.items.filter((it) => !AMOUNT.test(it.str.trim()));
    const first = words[0]?.str.trim() ?? "";
    const date = layout.rowDate(first, statementDate);
    const label = (date ? words.slice(1) : words).map((w) => w.str.trim()).join(" ");
    const balanceItem = amounts.find((a) => columnOf(a, cols!) === "balance");
    const balance = balanceItem ? toCents(balanceItem.str.trim()) : null;

    if (layout.opening.test(label)) {
      if (current.opening === null) current.opening = balance;
      row = null;
      continue;
    }
    if (layout.closing.test(label)) {
      current.closing = balance;
      row = null;
      continue;
    }
    if (layout.stop.test(label)) {
      stopped = true;
      row = null;
      continue;
    }
    if (layout.skip.test(label)) {
      row = null;
      continue;
    }
    if (date) {
      const money = amounts.find((a) => {
        const c = columnOf(a, cols!);
        return c === "withdrawal" || c === "deposit";
      });
      if (!money) {
        warnings.push("row_without_amount");
        row = null;
        continue;
      }
      const cents = toCents(money.str.trim());
      row = {
        date,
        type: label,
        details: [],
        cents: columnOf(money, cols) === "withdrawal" ? cents : -cents,
        balance,
      };
      current.rows.push(row);
      continue;
    }
    // A detail line belongs to the row above it.
    if (row && !amounts.length) row.details.push(text);
  }

  if (!sections.length) throw new ParseError("no_accounts");
  const seen = new Map<string, number>();
  const cards: ParsedCard[] = sections.map((s) => {
    const ordinal = (seen.get(s.productName) ?? 0) + 1;
    seen.set(s.productName, ordinal);
    // Every printed running balance must follow from the row before it: errors that
    // cancel out can still make opening − Σ rows equal the closing balance.
    let running = s.opening;
    let runningOk = true;
    for (const r of s.rows) {
      if (running !== null && r.balance !== null && running - r.cents !== r.balance) {
        warnings.push("running_balance_mismatch");
        runningOk = false;
        break;
      }
      running = r.balance ?? (running === null ? null : running - r.cents);
    }
    const rows: ParsedRow[] = s.rows.map((r) => {
      const { kind, rawDescriptor } = bankRow({ type: r.type, details: r.details, cents: r.cents });
      return {
        txnDate: r.date,
        postDate: null,
        amountCents: r.cents,
        rawDescriptor,
        refNo: null,
        fx: null,
        kind,
      };
    });
    const sum = rows.reduce((t, r) => t + r.amountCents, 0);
    const balances = s.opening !== null && s.closing !== null;
    // Balances signed like rows: money held is negative (types.ts).
    return {
      productName: s.productName,
      ordinal,
      previousBalanceCents: s.opening === null ? null : -s.opening,
      totalCents: s.closing === null ? null : -s.closing,
      reconciled: balances ? runningOk && s.opening! - sum === s.closing : false,
      rows,
    };
  });
  if (cards.some((c) => c.previousBalanceCents === null || c.totalCents === null))
    warnings.push("balance_not_found");

  return {
    names: holderName(lines, layout),
    statement: {
      bank: layout.bank,
      kind: "deposit",
      parserVersion: layout.version,
      statementDate,
      dueDate: null,
      minimumPaymentCents: null,
      statementTotalCents: null,
      totalsMatch: null,
      cards,
      warnings: [...new Set(warnings)],
    },
  };
}
