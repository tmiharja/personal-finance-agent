/**
 * Deterministic period resolution (PRD ASK-5). The model never works out dates:
 * it passes the user's words here and repeats the label it gets back.
 * "Q3" is the calendar quarter by transaction date, this year's if it has ended,
 * otherwise the most recent complete one. Today is Singapore time.
 */

export type Period = {
  from: string;
  to: string;
  /** e.g. "Q3 2026 (1 Jul – 30 Sep)". Always shown with the answer. */
  label: string;
};

export type PeriodResult =
  | (Period & { partial: boolean; note?: string })
  | { error: "unrecognised_period"; supported: string[] };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_FULL = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// Fixed abbreviations: ICU's en-GB data varies ("Sep" vs "Sept") across runtimes.
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dm = (isoDate: string) =>
  `${Number(isoDate.slice(8, 10))} ${MON[Number(isoDate.slice(5, 7)) - 1]}`;
const dmy = (isoDate: string) => `${dm(isoDate)} ${isoDate.slice(0, 4)}`;

function monthPeriod(y: number, m: number): Period {
  const name = MONTH_FULL[m - 1]!.replace(/^./, (c) => c.toUpperCase());
  return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)), label: `${name} ${y}` };
}

function quarterPeriod(y: number, q: number): Period {
  const from = iso(y, (q - 1) * 3 + 1, 1);
  const to = iso(y, q * 3, lastDay(y, q * 3));
  return { from, to, label: `Q${q} ${y} (${dm(from)} – ${dm(to)})` };
}

function rangePeriod(from: string, to: string, name?: string): Period {
  const span = `${dmy(from)} – ${dmy(to)}`;
  return { from, to, label: name ? `${name} (${span})` : span };
}

function monthIndex(word: string): number | null {
  const w = word.toLowerCase();
  const i = MONTH_FULL.indexOf(w);
  if (i >= 0) return i + 1;
  const j = MONTHS.indexOf(w.slice(0, 3));
  return j >= 0 && (w.length === 3 || MONTH_FULL[j]!.startsWith(w)) ? j + 1 : null;
}

export const SUPPORTED_PERIODS = [
  "this month",
  "last month",
  "March",
  "March 2026",
  "Q3",
  "Q3 2026",
  "this year",
  "last year",
  "2026",
  "year to date",
  "last 3 months",
  "last 30 days",
  "2026-01-01 to 2026-03-31",
];

/** Today's date in Singapore (YYYY-MM-DD). */
export function todaySgt(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function resolvePeriod(
  expression: string,
  today: string,
  coverage: { from: string; to: string } | null,
): PeriodResult {
  const p = parse(expression.trim().toLowerCase().replace(/\s+/g, " "), today);
  if (!p) return { error: "unrecognised_period", supported: SUPPORTED_PERIODS };
  const partial = !coverage || p.from < coverage.from || p.to > coverage.to;
  return {
    ...p,
    partial,
    ...(partial && coverage
      ? {
          note: `Your imported statements cover ${dmy(coverage.from)} – ${dmy(coverage.to)}, so this period is only partly covered.`,
        }
      : partial
        ? { note: "No statements have been imported yet." }
        : {}),
  };
}

function parse(e: string, today: string): Period | null {
  const [ty, tm] = today.split("-").map(Number) as [number, number];
  let m: RegExpMatchArray | null;

  if ((m = e.match(/^(\d{4}-\d{2}-\d{2})\s*(?:to|-|–|until)\s*(\d{4}-\d{2}-\d{2})$/))) {
    const [a, b] = [m[1]!, m[2]!].sort() as [string, string];
    return valid(a) && valid(b) ? rangePeriod(a, b) : null;
  }
  if (/^(this|current) month$|^month to date$|^mtd$/.test(e)) return monthPeriod(ty, tm);
  if (/^(last|previous|prior) month$/.test(e))
    return tm === 1 ? monthPeriod(ty - 1, 12) : monthPeriod(ty, tm - 1);
  if (/^(this|current) year$|^year to date$|^ytd$/.test(e))
    return rangePeriod(`${ty}-01-01`, today, `${ty} to date`);
  if (/^(last|previous|prior) year$/.test(e))
    return rangePeriod(`${ty - 1}-01-01`, `${ty - 1}-12-31`, String(ty - 1));
  if ((m = e.match(/^(?:the )?(?:last|past|previous) (\d{1,2}) months?$/))) {
    const n = Number(m[1]);
    if (n < 1 || n > 36) return null;
    // n full calendar months before the current one.
    const start = new Date(Date.UTC(ty, tm - 1 - n, 1));
    const end = new Date(Date.UTC(ty, tm - 1, 0));
    return rangePeriod(
      start.toISOString().slice(0, 10),
      end.toISOString().slice(0, 10),
      `Last ${n} months`,
    );
  }
  if ((m = e.match(/^(?:the )?(?:last|past) (\d{1,3}) days$/))) {
    const n = Number(m[1]);
    if (n < 1 || n > 731) return null;
    const start = new Date(Date.parse(`${today}T00:00:00Z`) - (n - 1) * 86400_000)
      .toISOString()
      .slice(0, 10);
    return rangePeriod(start, today, `Last ${n} days`);
  }
  if ((m = e.match(/^(?:in )?(\d{4})$/))) {
    const y = Number(m[1]);
    return y >= 2000 && y <= 2100 ? rangePeriod(`${y}-01-01`, `${y}-12-31`, String(y)) : null;
  }
  if ((m = e.match(/^q([1-4])(?: (\d{4}))?$/))) {
    const q = Number(m[1]);
    if (m[2]) return quarterPeriod(Number(m[2]), q);
    // This year's quarter if it has ended, else the most recent complete one.
    const ended = quarterPeriod(ty, q).to < today;
    return quarterPeriod(ended ? ty : ty - 1, q);
  }
  if ((m = e.match(/^([a-z]+)(?: (\d{4}))?$/))) {
    const month = monthIndex(m[1]!);
    if (!month) return null;
    if (m[2]) return monthPeriod(Number(m[2]), month);
    // A bare month: this year's if it has started, else last year's.
    return monthPeriod(month <= tm ? ty : ty - 1, month);
  }
  return null;
}

function valid(d: string): boolean {
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}
