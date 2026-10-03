/**
 * The numbers guard (PRD ASK-3): every figure in an answer must trace back to a
 * tool result. Deterministic: numbers are pulled out of the answer and each must
 * equal a number from the tool results (or the question) at the precision shown.
 */

/** value = the number as written × scale; decimals as written (at that scale). */
type Found = { raw: string; value: number; decimals: number; scale: number };

// "S$1,234.56", "1,234", "12.5%", "1.2k", "−45.90". Dates like 2026-03-01 split
// into parts, which match the date parts of tool results.
const NUMBER = /(?<![\w.])[-−]?(?:S\$|\$)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(k|K)?(?![\w])/g;

export function extractNumbers(text: string): Found[] {
  const out: Found[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const int = m[1]!.replace(/,/g, "");
    const frac = m[2] ?? "";
    const scale = m[3] ? 1000 : 1;
    out.push({
      raw: m[0].trim(),
      value: Number(int + frac) * scale,
      decimals: frac ? frac.length - 1 : 0,
      scale,
    });
  }
  return out;
}

/** Every number in a tool result, recursively, including the parts of dates. */
export function collectNumbers(value: unknown, into: number[] = []): number[] {
  if (typeof value === "number") into.push(value);
  else if (typeof value === "string") {
    for (const f of extractNumbers(value.replace(/-/g, " "))) into.push(f.value);
    if (/^-?\d+(\.\d+)?$/.test(value)) into.push(Number(value));
  } else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, into));
  else if (value && typeof value === "object")
    Object.values(value).forEach((v) => collectNumbers(v, into));
  return into;
}

const roundTo = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export type GuardResult = { ok: true } | { ok: false; unsupported: string[] };

export function checkNumbers(answer: string, allowed: readonly number[]): GuardResult {
  const pool = allowed.map(Math.abs);
  const unsupported: string[] = [];
  for (const f of extractNumbers(answer)) {
    const v = Math.abs(f.value);
    // Equal to a tool number, or that number rounded to the precision written.
    const ok = pool.some(
      (a) =>
        Math.abs(a - v) < 1e-9 || Math.abs(roundTo(a / f.scale, f.decimals) - v / f.scale) < 1e-9,
    );
    if (!ok) unsupported.push(f.raw);
  }
  return unsupported.length ? { ok: false, unsupported: [...new Set(unsupported)] } : { ok: true };
}

const money = (sgd: string) =>
  `S$${Number(sgd).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * When the answer fails the guard twice, the tool's own figures are shown
 * instead, rendered deterministically from the last data result.
 */
export function fallbackAnswer(
  results: { name: string; result: Record<string, unknown> }[],
): string {
  const last = [...results]
    .reverse()
    .find(
      (r) => r.name !== "resolve_period" && r.name !== "list_categories" && !("error" in r.result),
    );
  if (!last)
    return "I couldn't answer that reliably from your data. Try asking about spending in a specific period.";
  const r = last.result as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (last.name) {
    case "spend_summary":
      return `Spend ${r["category"] !== "all" ? `on ${r["category"]} ` : ""}${r["merchant"] !== "all" ? `at ${r["merchant"]} ` : ""}from ${r["from"]} to ${r["to"]}: ${money(r["spent_sgd"])} across ${r["transactions"]} transactions.`;
    case "spend_by_category":
      return [
        `Spend from ${r["from"]} to ${r["to"]}: ${money(r["total_spent_sgd"])}.`,
        ...(r["categories"] as { category: string; spent_sgd: string }[])
          .slice(0, 8)
          .map((c) => `${c.category}: ${money(c.spent_sgd)}`),
      ].join("\n");
    case "compare_periods": {
      const a = r["first"] as { from: string; to: string; spent_sgd: string };
      const b = r["second"] as { from: string; to: string; spent_sgd: string };
      return `${a.from} to ${a.to}: ${money(a.spent_sgd)}. ${b.from} to ${b.to}: ${money(b.spent_sgd)}.`;
    }
    case "top_merchants":
      return (
        (r["merchants"] as { rank: number; merchant: string; spent_sgd: string }[])
          .map((m) => `${m.rank}. ${m.merchant}: ${money(m.spent_sgd)}`)
          .join("\n") || "No spending in that period."
      );
    case "monthly_spend":
      return (r["months"] as { month: string; spent_sgd: string }[])
        .map((m) => `${m.month}: ${money(m.spent_sgd)}`)
        .join("\n");
    case "find_transactions":
      return (
        (r["transactions"] as { date: string; merchant: string; amount_sgd: string }[])
          .map((t) => `${t.date} ${t.merchant}: ${money(t.amount_sgd)}`)
          .join("\n") || "No matching transactions."
      );
    default:
      return "I couldn't answer that reliably from your data.";
  }
}
