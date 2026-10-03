import { lookupMerchant } from "@/server/categorise/merchant-map";

/**
 * Merchant normalisation (PRD CAT-2): sanitised descriptor → short merchant name
 * for grouping ("GRAB* A-…" → "Grab"). Known brands come from the curated map
 * (src/server/categorise/merchant-map.ts); anything else is cleaned of location
 * noise and title-cased.
 */

// Trailing location noise, including the run-together form ("…MALLSINGAPORE").
const TRAILING = /(?:\s*(?:SINGAPORE|SGP|SG|N\/A|IRL|JPN|IDN|NL|CA|SWE)\b|SINGAPORE)+\s*$/i;

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|[\s/@&(-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());

export function normaliseMerchant(descriptor: string): string {
  const known = lookupMerchant(descriptor)?.merchant;
  if (known) return known;
  const base = descriptor
    // "PAYNOW TO SAMPLE PROPERTY PTE LTD": the payee is the merchant.
    .replace(/^(PAYNOW|FAST|FUNDS) (TO|FROM) /i, "")
    .replace(/#/g, "")
    .replace(TRAILING, "")
    .replace(/\s+/g, " ")
    .trim();
  return titleCase(base || descriptor).slice(0, 60);
}
