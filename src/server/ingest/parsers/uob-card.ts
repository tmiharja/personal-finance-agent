import type { Line } from "../pdf";
import {
  type CardDraft,
  finaliseCards,
  classify,
  cleanDescriptor,
  inferDate,
  normaliseFxAmount,
  parseFullDate,
  splitAmount,
  toCents,
} from "./common";
import { ParseError, type ParsedRow, type ParseResult } from "./types";

export const UOB_CARD_VERSION = "uob-card-pdf@1";

/** docs/statement-formats.md §2 */
export function isUobCard(lines: Line[]): boolean {
  const all = lines.map((l) => l.text);
  return (
    all.some((t) => /United Overseas Bank Limited/i.test(t)) &&
    all.some((t) => /Credit Card\(s\) Statement/i.test(t)) &&
    all.some((t) => /Description of Transaction/i.test(t))
  );
}

const CARD_LINE = /^(\d{4}-\d{4}-\d{4}-\d{4})\s+([A-Z][A-Z .,'/-]*?)\s*(\(continued\))?$/;
const ROW = /^(\d{2} [A-Z]{3})\s+(\d{2} [A-Z]{3})\s+(.+)$/;
const REF = /^Ref No\.\s*:\s*(\d+)$/i;
const FX = /^([A-Z]{3})\s+([\d,]+\.\d{2})$/;
const TOTAL_FOR = /^TOTAL BALANCE FOR\s+(.+)$/i;
const STOP = /End of Transaction Details/i;

type Draft = CardDraft;

function headerValue(lines: Line[], label: RegExp): string | null {
  for (const l of lines) {
    const m = label.exec(l.text);
    if (m) return m[1]!;
  }
  return null;
}

export function parseUobCard(lines: Line[]): ParseResult {
  const warnings: string[] = [];
  const names = new Set<string>();
  const page1 = lines.filter((l) => l.page === 1);

  const stmt = headerValue(page1, /Statement Date\s+(\d{1,2} [A-Z]{3} \d{4})/i);
  const statementDate = stmt ? parseFullDate(stmt) : null;
  if (!statementDate) throw new ParseError("no_statement_date");
  const due = headerValue(page1, /Due Date\s+(\d{1,2} [A-Z]{3} \d{4})/i);
  const minimum = headerValue(page1, /Minimum Payment\s+SGD\s*([\d,]+\.\d{2})/i);
  const toPay = headerValue(page1, /Amount to Pay\s+SGD\s*([\d,]+\.\d{2})/i);

  const drafts: Draft[] = [];
  let card: Draft | null = null;
  let lastRow: ParsedRow | null = null;
  let previousLine = "";
  const refs: string[] = [];

  for (const line of lines) {
    const text = line.text;
    if (STOP.test(text)) break;

    const cardLine = CARD_LINE.exec(text);
    if (cardLine) {
      names.add(cardLine[2]!.trim());
      if (!cardLine[3]) {
        refs.push(cardLine[1]!.replace(/\D/g, ""));
        // The product name is the title line just above the number line.
        card = {
          productName: cleanDescriptor(previousLine),
          previousBalanceCents: 0,
          totalCents: 0,
          rows: [],
          hasTotal: false,
          hasPrevious: false,
        };
        drafts.push(card);
      }
      lastRow = null;
      previousLine = text;
      continue;
    }
    previousLine = text;
    if (!card) continue;

    const { left, cents } = splitAmount(line);
    if (/^PREVIOUS BALANCE$/i.test(left) && cents !== null) {
      card.previousBalanceCents = cents;
      card.hasPrevious = true;
      continue;
    }
    if (/^SUB TOTAL$/i.test(left)) continue;
    const tf = TOTAL_FOR.exec(left);
    if (tf && cents !== null) {
      card.totalCents = cents;
      card.hasTotal = true;
      if (cleanDescriptor(tf[1]!) !== card.productName) warnings.push("card_name_mismatch");
      lastRow = null;
      continue;
    }
    if (cents !== null) {
      const row = ROW.exec(left);
      if (!row) continue;
      const postDate = inferDate(row[1]!, statementDate);
      const txnDate = inferDate(row[2]!, statementDate);
      if (!postDate || !txnDate) continue;
      const rawDescriptor = cleanDescriptor(row[3]!);
      lastRow = {
        txnDate,
        postDate,
        amountCents: cents,
        rawDescriptor,
        refNo: null,
        fx: null,
        kind: classify(rawDescriptor, cents),
      };
      card.rows.push(lastRow);
      continue;
    }
    if (!lastRow) continue;
    const ref = REF.exec(text);
    if (ref) {
      lastRow.refNo = ref[1]!;
      continue;
    }
    const fx = FX.exec(text);
    if (fx && !lastRow.fx) lastRow.fx = { currency: fx[1]!, amount: normaliseFxAmount(fx[2]!) };
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
  const statementTotalCents = toPay ? toCents(toPay) : null;
  const sum = cards.reduce((s, c) => s + c.totalCents, 0);
  return {
    names: [...names],
    accountRefs: refs,
    statement: {
      bank: "UOB",
      kind: "card",
      parserVersion: UOB_CARD_VERSION,
      statementDate,
      dueDate: due ? parseFullDate(due) : null,
      minimumPaymentCents: minimum ? toCents(minimum) : null,
      statementTotalCents,
      totalsMatch: statementTotalCents === null ? null : sum === statementTotalCents,
      cards,
      warnings,
    },
  };
}
