import { sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { todaySgt } from "@/server/agent/period";
import { logError } from "@/server/log";
import type { ParsedStatement } from "./parsers";

export type ParseMethod = "parser" | "ai";

/** How a parsed statement came out: every section reconciled, one didn't, or nothing to check. */
export function reconcileOutcome(st: ParsedStatement): string {
  if (st.totalsMatch === false || st.cards.some((c) => c.reconciled === false))
    return "unreconciled";
  if (st.cards.some((c) => c.reconciled === null)) return "no_balance";
  return "reconciled";
}

/**
 * Counts one parse outcome for the admin page (PRD OPS-3): day, bank, method and
 * outcome only. Best effort: a stats failure never fails an import.
 */
export async function recordParseOutcome(
  db: AppDb,
  o: { bank: string; method: ParseMethod; outcome: string },
): Promise<void> {
  try {
    await db.execute(sql`
      insert into parse_stats (day, bank, method, outcome, n)
      values (${todaySgt()}, ${o.bank}, ${o.method}, ${o.outcome}, 1)
      on conflict (day, bank, method, outcome) do update set n = parse_stats.n + 1`);
  } catch (e) {
    logError("parse_stats.record", e);
  }
}
