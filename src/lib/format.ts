/** S$ amounts from cents: "S$1,234.56", credits as "−S$12.00". */
export function money(cents: number, { signed = false } = {}): string {
  const abs = (Math.abs(cents) / 100).toLocaleString("en-SG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (cents < 0) return `−S$${abs}`;
  return signed && cents > 0 ? `+S$${abs}` : `S$${abs}`;
}

// Fixed month names: ICU data differs between runtimes ("Sep" vs "Sept"), and
// the server and the browser must render the same text.
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MON = MONTHS.map((m) => m.slice(0, 3));

/** "2026-03-14" → "14 Mar 2026" (PRD §7.4). */
export function longDate(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

/** "2026-03-14" → "14 Mar". */
export function shortDate(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;
}

/** "2026-03" → "March 2026" (long), "Mar 2026" (medium), "Mar" (short), "M" (narrow). */
export function monthLabel(month: string, style: "long" | "medium" | "short" | "narrow"): string {
  const i = Number(month.slice(5, 7)) - 1;
  const year = month.slice(0, 4);
  if (style === "long") return `${MONTHS[i]} ${year}`;
  if (style === "medium") return `${MON[i]} ${year}`;
  if (style === "short") return MON[i]!;
  return MONTHS[i]![0]!;
}

const ACRONYMS = /\b(Dbs|Posb|Uob|Ocbc|Hsbc|Amex)(?=\b|\s|$)/g;

/** "UOB SAMPLE MILES VISA CARD" → "UOB Sample Miles Visa Card" (bank acronyms kept). */
export const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|[\s/(-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase())
    .replace(ACRONYMS, (m) => m.toUpperCase());
