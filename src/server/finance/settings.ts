import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { accounts, budgets, categories, rules } from "@/db/schema";
import { withUser } from "@/db/with-user";

/** What Settings shows: your accounts, budgets and rules (no descriptors, no numbers). */
export type SettingsView = {
  accounts: {
    id: string;
    name: string;
    bank: string;
    kind: "card" | "deposit";
    statements: number;
    latest: string | null;
  }[];
  budgets: { categoryId: string; category: string; cents: number | null }[];
  rules: { id: string; pattern: string; categoryId: string; category: string }[];
  /** Categories a rule can point at. */
  ruleCategories: { id: string; name: string }[];
};

export async function getSettings(db: AppDb, userId: string): Promise<SettingsView> {
  return withUser(db, userId, async (tx) => {
    const accts = sqlRows<{
      id: string;
      name: string;
      bank: string;
      kind: "card" | "deposit";
      statements: number;
      latest: string | null;
    }>(
      await tx.execute(sql`
        select a.id, case when a.ordinal > 1 then a.product_name || ' (' || a.ordinal || ')' else a.product_name end as name,
               a.bank, a.kind, count(s.id)::int as statements, max(s.statement_date)::text as latest
        from ${accounts} a left join statements s on s.account_id = a.id
        group by a.id order by a.kind, a.bank, a.product_name, a.ordinal`),
    );
    const cats = await tx
      .select({ id: categories.id, name: categories.name, kind: categories.kind })
      .from(categories)
      .where(and(eq(categories.hidden, false), inArray(categories.kind, ["expense", "income"])))
      .orderBy(asc(categories.sort), asc(categories.name));
    const set = new Map(
      (
        await tx.select({ id: budgets.categoryId, cents: budgets.monthlyAmountCents }).from(budgets)
      ).map((b) => [b.id, b.cents]),
    );
    const ruleRows = await tx
      .select({
        id: rules.id,
        pattern: rules.pattern,
        categoryId: rules.categoryId,
        category: categories.name,
      })
      .from(rules)
      .innerJoin(categories, eq(categories.id, rules.categoryId))
      .orderBy(sql`lower(${rules.pattern})`);
    return {
      accounts: accts,
      budgets: cats
        .filter((c) => c.kind === "expense")
        .map((c) => ({ categoryId: c.id, category: c.name, cents: set.get(c.id) ?? null })),
      rules: ruleRows,
      ruleCategories: cats.map((c) => ({ id: c.id, name: c.name })),
    };
  });
}
