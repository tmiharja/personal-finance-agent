/**
 * Transaction kinds, shared by the schema, the server and client components.
 * Card statements produce the first five; bank accounts add income and transfer.
 */
export const TXN_KINDS = [
  "charge",
  "refund",
  "card_payment",
  "fee",
  "cashback",
  // Bank accounts (Phase 2b): money in that isn't a refund, and moves between your own accounts.
  "income",
  "transfer",
] as const;

export type TxnKind = (typeof TXN_KINDS)[number];

/** Kinds whose category is set by the kind itself and can't be changed row by row. */
export const FIXED_KINDS = ["card_payment", "fee", "cashback", "transfer"] as const;

/** Never spend or income: money moving between your own accounts and cards (PRD IMP-10). */
export const TRANSFER_KINDS = ["card_payment", "transfer"] as const;
