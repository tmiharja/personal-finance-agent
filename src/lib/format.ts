/** S$ amounts from cents: "S$1,234.56", credits as "−S$12.00". */
export function money(cents: number, { signed = false } = {}): string {
  const abs = (Math.abs(cents) / 100).toLocaleString("en-SG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (cents < 0) return `−S$${abs}`;
  return signed && cents > 0 ? `+S$${abs}` : `S$${abs}`;
}

/** "2026-03-14" → "14 Mar 2026" (PRD §7.4). */
export function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00+08:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Singapore",
  });
}

/** "2026-03-14" → "14 Mar". */
export function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00+08:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Singapore",
  });
}

const ACRONYMS = /\b(Dbs|Posb|Uob|Ocbc|Hsbc|Amex)(?=\b|\s|$)/g;

/** "UOB SAMPLE MILES VISA CARD" → "UOB Sample Miles Visa Card" (bank acronyms kept). */
export const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|[\s/(-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase())
    .replace(ACRONYMS, (m) => m.toUpperCase());
