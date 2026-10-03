/**
 * Merchant normalisation: sanitised descriptor → short merchant name for
 * grouping ("GRAB* A-…" → "Grab"). Phase 0 keeps a small built-in map and a
 * generic fallback; Phase 1 adds the curated merchant_map table and user rules.
 */

const KNOWN: readonly [RegExp, string][] = [
  [/^GRAB\*/i, "Grab"],
  [/^BUS\/MRT\b/i, "SimplyGo / Transit"],
  [/^SHOPEE\b/i, "Shopee"],
  [/^LAZADA\b/i, "Lazada"],
  [/^NETFLIX\b/i, "Netflix"],
  [/^SPOTIFY\b/i, "Spotify"],
  [/^APPLE\.COM\/BILL\b/i, "Apple"],
  [/^DISNEY PLUS\b/i, "Disney Plus"],
  [/^FOODPANDA\b/i, "foodpanda"],
  [/^STARBUCKS\b/i, "Starbucks"],
  [/^SINGTEL\b/i, "Singtel"],
  [/^SP DIGITAL\b/i, "SP Digital"],
  [/^(AUTOPAY|GIRO PAYMENT)\b/i, "Card payment"],
  [/^(ANNUAL FEE|GST @)/i, "Card fees"],
  [/\bCARD CASHBACK$/i, "Card cashback"],
];

// Trailing location noise, including the run-together form ("…MALLSINGAPORE").
const TRAILING = /(?:\s*(?:SINGAPORE|SGP|SG|N\/A|IRL|JPN|IDN|NL|CA|SWE)\b|SINGAPORE)+\s*$/i;

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|[\s/@&(-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());

export function normaliseMerchant(descriptor: string): string {
  for (const [re, name] of KNOWN) if (re.test(descriptor)) return name;
  const base = descriptor.replace(/#/g, "").replace(TRAILING, "").replace(/\s+/g, " ").trim();
  return titleCase(base || descriptor).slice(0, 60);
}
