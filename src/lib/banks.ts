/**
 * Banks the app knows. DBS/POSB and UOB have deterministic parsers; the rest
 * arrive only through the AI fallback extractor (PRD IMP-5), marked for review.
 */
export const BANKS = [
  "DBS",
  "UOB",
  "OCBC",
  "CITI",
  "HSBC",
  "SCB",
  "MAYBANK",
  "AMEX",
  "OTHER",
] as const;
export type Bank = (typeof BANKS)[number];

export const BANK_LABEL: Record<Bank, string> = {
  DBS: "DBS/POSB",
  UOB: "UOB",
  OCBC: "OCBC",
  CITI: "Citibank",
  HSBC: "HSBC",
  SCB: "Standard Chartered",
  MAYBANK: "Maybank",
  AMEX: "American Express",
  OTHER: "Other bank",
};
