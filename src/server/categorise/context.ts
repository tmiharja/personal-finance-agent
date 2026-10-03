import { and, eq, gt, or, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { categories, imports, rules } from "@/db/schema";
import { withUser, type Tx } from "@/db/with-user";
import { getEnv } from "@/env";
import { describeRow, ensureDefaultCategories } from "@/server/finance/ledger";
import type { ParsedStatement } from "@/server/ingest/parsers";
import { getLlm } from "@/server/llm/client";
import { budgetBlock, recordUsage } from "@/server/llm/usage";
import type { PiiContext } from "@/server/pii/firewall";
import {
  categoriseRows,
  type Categorised,
  type CategoriseContext,
  type UserRule,
} from "./categorise";

/** The user's rules, category names and earlier classifier decisions. */
export async function loadCategoriseContext(
  tx: Tx,
  userId: string,
): Promise<Pick<CategoriseContext, "rules" | "history" | "categories">> {
  await ensureDefaultCategories(tx, userId);
  const cats = await tx
    .select({
      id: categories.id,
      name: categories.name,
      kind: categories.kind,
      hidden: categories.hidden,
    })
    .from(categories);
  const nameById = new Map(cats.map((c) => [c.id, c.name]));
  const userRules: UserRule[] = (await tx.select().from(rules)).flatMap((r) => {
    const categoryName = nameById.get(r.categoryId);
    return categoryName
      ? [{ match: r.match, pattern: r.pattern, categoryName, priority: r.priority }]
      : [];
  });
  const history = sqlRows<{ merchant: string; name: string; confidence: number | null }>(
    await tx.execute(sql`
      select distinct on (lower(t.merchant_name)) lower(t.merchant_name) as merchant, c.name, t.confidence
      from transactions t join categories c on c.id = t.category_id
      where t.category_source = 'llm' and t.merchant_name is not null
      order by lower(t.merchant_name), t.created_at desc`),
  );
  return {
    rules: userRules,
    history: new Map(
      history.map((h) => [h.merchant, { categoryName: h.name, confidence: h.confidence }]),
    ),
    categories: cats
      .filter((c) => !c.hidden && (c.kind === "expense" || c.name === "Uncategorised"))
      .map((c) => c.name),
  };
}

export type StatementCategories = {
  /** Per card, per row: same shape as statement.cards[].rows. */
  byCard: Categorised[][];
  llmCalls: number;
  warnings: string[];
};

/**
 * Categorises a parsed statement before its preview is built. Returns null when
 * this file already has a live preview or was committed (nothing to do, and no
 * model call wasted on a re-upload). Model usage is recorded for the user.
 */
export async function categoriseStatement(
  db: AppDb,
  userId: string,
  fileSha256: string,
  parsed: { statement: ParsedStatement; names: string[] },
): Promise<StatementCategories | null> {
  const ctx = await withUser(db, userId, async (tx) => {
    const [live] = await tx
      .select({ id: imports.id })
      .from(imports)
      .where(
        and(
          eq(imports.fileSha256, fileSha256),
          or(
            eq(imports.status, "committed"),
            and(eq(imports.status, "previewed"), gt(imports.expiresAt, new Date())),
          ),
        ),
      );
    return live ? null : loadCategoriseContext(tx, userId);
  });
  if (!ctx) return null;

  const pii: PiiContext = { names: parsed.names };
  const flat = parsed.statement.cards.flatMap((card) =>
    card.rows.map((r) => ({
      ...describeRow(r.rawDescriptor, pii),
      kind: r.kind,
      amountCents: r.amountCents,
      fx: r.fx,
    })),
  );

  const env = getEnv();
  const blocked = await budgetBlock(db, userId, "categorise");
  const llm = blocked ? null : await getLlm();
  const result = await categoriseRows(flat, { ...ctx, llm, model: env.MODEL_CATEGORISE, pii });
  if (result.llmCalls > 0) {
    await withUser(db, userId, (tx) =>
      recordUsage(tx, userId, "categorise", result.model, result.usage),
    );
  }

  const byCard: Categorised[][] = [];
  let at = 0;
  for (const card of parsed.statement.cards) {
    byCard.push(result.results.slice(at, at + card.rows.length));
    at += card.rows.length;
  }
  return {
    byCard,
    llmCalls: result.llmCalls,
    // Over budget: say so instead of "unavailable".
    warnings: blocked
      ? result.warnings.map((w) => (w === "categoriser_unavailable" ? "categoriser_paused" : w))
      : result.warnings,
  };
}
