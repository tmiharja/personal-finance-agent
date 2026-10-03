import type { Line } from "../pdf";
import {
  type CardDraft,
  finaliseCards,
  classify,
  cleanDescriptor,
  currencyFromName,
  inferDate,
  normaliseFxAmount,
  parseFullDate,
  splitAmount,
  toCents,
} from "./common";
import { ParseError, type ParsedRow, type ParseResult } from "./types";

export const DBS_CARD_VERSION = "dbs-card-pdf@1";

/** docs/statement-formats.md §1 */
export function isDbsCard(lines: Line[]): boolean {
  const head = lines.filter((l) => l.page === 1).map((l) => l.text);
  return (
    head.some((t) => /^Credit Cards\b/.test(t)) &&
    head.some((t) => /Statement of Account/.test(t)) &&
    head.some((t) => /DBS Cards P\.O\. Box/i.test(t))
  );
}

const CARD_START = /^(.+?) CARD NO\.:\s*([\d ]{13,23})$/;
const NEW_TXNS = /^NEW TRANSACTIONS\s+(.+)$/;
const ROW = /^(\d{2} [A-Z]{3})\s+(.+)$/;
const REF = /^REF NO:\s*(\d+)$/i;
const FX = /^([A-Z][A-Z .]+?)\s+(\d[\d,]*\.\d{2})$/;
const STOP = /POINTS SUMMARY|USEFUL INFORMATION|SPECIALLY FOR YOU/i;

type Draft = CardDraft;

export function parseDbsCard(lines: Line[]): ParseResult {
  const warnings: string[] = [];
  const names = new Set<string>();

  // Header: the line after "STATEMENT DATE … PAYMENT DUE DATE".
  let statementDate: string | null = null;
  let dueDate: string | null = null;
  let minimumPaymentCents: number | null = null;
  const hdr = lines.findIndex(
    (l) => /STATEMENT DATE/.test(l.text) && /PAYMENT DUE DATE/.test(l.text),
  );
  if (hdr >= 0) {
    for (const l of lines.slice(hdr + 1, hdr + 3)) {
      const dates = [...l.text.matchAll(/\b\d{1,2} [A-Z][a-z]{2} \d{4}\b/g)].map((m) =>
        parseFullDate(m[0]),
      );
      const money = [...l.text.matchAll(/\$([\d,]+\.\d{2})/g)].map((m) => toCents(m[1]!));
      if (dates.length >= 2) {
        statementDate = dates[0]!;
        dueDate = dates.at(-1)!;
        if (money.length >= 2) minimumPaymentCents = money[1]!;
        break;
      }
    }
  }
  if (!statementDate) throw new ParseError("no_statement_date");

  const drafts: Draft[] = [];
  let card: Draft | null = null;
  let lastRow: ParsedRow | null = null;
  let statementTotalCents: number | null = null;

  const refs: string[] = [];
  for (const line of lines) {
    const text = line.text;
    if (STOP.test(text)) break;

    const start = CARD_START.exec(text);
    if (start) {
      refs.push(start[2]!.replace(/\D/g, ""));
      card = {
        productName: cleanDescriptor(start[1]!),
        previousBalanceCents: 0,
        totalCents: 0,
        rows: [],
        hasTotal: false,
        hasPrevious: false,
      };
      drafts.push(card);
      lastRow = null;
      continue;
    }
    const { left, cents } = splitAmount(line);

    if (/GRAND TOTAL FOR ALL CARD ACCOUNTS/i.test(left) && cents !== null) {
      statementTotalCents = cents;
      continue;
    }
    if (!card) continue;

    const nt = NEW_TXNS.exec(text);
    if (nt) {
      names.add(nt[1]!.trim());
      lastRow = null;
      continue;
    }
    if (/^PREVIOUS BALANCE$/i.test(left) && cents !== null) {
      card.previousBalanceCents = cents;
      card.hasPrevious = true;
      continue;
    }
    if (/^SUB-TOTAL:$/i.test(left)) continue;
    if (/^TOTAL:$/i.test(left) && cents !== null) {
      card.totalCents = cents;
      card.hasTotal = true;
      lastRow = null;
      continue;
    }
    if (cents !== null) {
      const row = ROW.exec(left);
      if (!row) continue;
      const txnDate = inferDate(row[1]!, statementDate);
      if (!txnDate) continue;
      const rawDescriptor = cleanDescriptor(row[2]!);
      lastRow = {
        txnDate,
        postDate: null,
        amountCents: cents,
        rawDescriptor,
        refNo: null,
        fx: null,
        kind: classify(rawDescriptor, cents),
      };
      card.rows.push(lastRow);
      continue;
    }
    // Continuation lines belong to the row above.
    if (!lastRow) continue;
    const ref = REF.exec(text);
    if (ref) {
      lastRow.refNo = ref[1]!;
      continue;
    }
    const fx = FX.exec(text);
    if (fx && !lastRow.fx) {
      const currency = currencyFromName(fx[1]!);
      if (!currency) warnings.push("fx_currency_unknown");
      lastRow.fx = { currency, amount: normaliseFxAmount(fx[2]!) };
    }
  }

  if (!drafts.length) throw new ParseError("no_cards");
  drafts.forEach((d, i) => {
    if (!d.hasTotal) warnings.push(`card_${i + 1}_total_missing`);
    if (!d.hasPrevious) warnings.push(`card_${i + 1}_previous_missing`);
  });
  const cards = finaliseCards(drafts);
  cards.forEach((c, i) => {
    if (!c.reconciled) warnings.push(`card_${i + 1}_unreconciled`);
  });
  const sum = cards.reduce((s, c) => s + c.totalCents, 0);
  return {
    names: [...names],
    accountRefs: refs,
    statement: {
      bank: "DBS",
      kind: "card",
      parserVersion: DBS_CARD_VERSION,
      statementDate,
      dueDate,
      minimumPaymentCents,
      statementTotalCents,
      totalsMatch: statementTotalCents === null ? null : sum === statementTotalCents,
      cards,
      warnings,
    },
  };
}
