import { z } from "zod";

/**
 * Parser output (docs/statement-formats.md §3). It is held in memory only: raw
 * descriptors and reference numbers go through the PII firewall and the dedupe
 * hash before anything is stored. There is deliberately no field for a card
 * number, cardholder name, address, credit limit or bank account, and the
 * schema is strict so none can be added by accident.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const parsedRowSchema = z.strictObject({
  txnDate: isoDate,
  postDate: isoDate.nullable(),
  amountCents: z.number().int(),
  rawDescriptor: z.string().min(1),
  refNo: z.string().nullable(),
  fx: z.strictObject({ currency: z.string().length(3).nullable(), amount: z.string() }).nullable(),
  kind: z.enum(["charge", "refund", "card_payment", "fee", "cashback"]),
});

export const parsedCardSchema = z.strictObject({
  productName: z.string().min(2),
  ordinal: z.number().int().min(1),
  previousBalanceCents: z.number().int(),
  totalCents: z.number().int(),
  reconciled: z.boolean(),
  rows: z.array(parsedRowSchema),
});

export const parsedStatementSchema = z.strictObject({
  bank: z.enum(["DBS", "UOB"]),
  parserVersion: z.string(),
  statementDate: isoDate,
  dueDate: isoDate.nullable(),
  minimumPaymentCents: z.number().int().nullable(),
  statementTotalCents: z.number().int().nullable(),
  /** Σ card totals == printed statement total (null when no total was printed). */
  totalsMatch: z.boolean().nullable(),
  cards: z.array(parsedCardSchema).min(1),
  /** Codes only, never values. */
  warnings: z.array(z.string()),
});

export type ParsedRow = z.infer<typeof parsedRowSchema>;
export type ParsedCard = z.infer<typeof parsedCardSchema>;
export type ParsedStatement = z.infer<typeof parsedStatementSchema>;

export type ParseResult = {
  statement: ParsedStatement;
  /**
   * Cardholder names seen in this file, for the PII firewall's name check.
   * In memory only for the duration of the import request; never stored.
   */
  names: string[];
};

export class ParseError extends Error {
  constructor(
    readonly code: "unsupported_format" | "no_cards" | "no_statement_date" | "invalid_output",
  ) {
    super(`Parse error: ${code}`);
    this.name = "ParseError";
  }
}
