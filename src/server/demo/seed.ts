import type { Bank } from "@/lib/banks";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppDb } from "@/db/client";
import { budgets } from "@/db/schema";
import { withUser } from "@/db/with-user";
import type { MasterKeys } from "@/server/crypto/envelope";
import { createHash } from "node:crypto";
import { resolveDeterministic } from "@/server/categorise/categorise";
import { getUserCrypto } from "@/server/crypto/user-keys";
import {
  DEFAULT_CATEGORIES,
  describeRow,
  ensureDefaultCategories,
  insertCardStatement,
  upsertAccount,
  type LedgerRow,
} from "@/server/finance/ledger";
import { pairTransfers } from "@/server/finance/transfers";

/** Shape of evals/fixtures/synthetic/<dir>/*.expected.json (docs/statement-formats.md §3). */
type ExpectedStatement = {
  synthetic: true;
  bank: Bank;
  /** Absent on card fixtures. */
  kind?: "card" | "deposit";
  statementDate: string;
  dueDate?: string;
  minimumPaymentCents?: number;
  cards: {
    productName: string;
    ordinal: number;
    previousBalanceCents: number | null;
    totalCents: number | null;
    rows: (Omit<LedgerRow, "categoryName" | "refNo"> & { expectedCategory: string })[];
  }[];
};

const FIXTURE_DIRS = ["dbs", "uob", "posb", "uob-one"] as const;

/** Card statements, then the bank accounts' PDF statements (their CSVs carry the same rows). */
export function loadFixtureStatements(): ExpectedStatement[] {
  const out: ExpectedStatement[] = [];
  for (const bank of FIXTURE_DIRS) {
    // A statically scoped path, so the build traces only this folder; next.config.ts
    // narrows it to the expected JSON (never the PDFs or CSVs).
    for (const f of readdirSync(join(process.cwd(), "evals", "fixtures", "synthetic", bank))
      .filter((n) => n.endsWith(".expected.json") && !n.endsWith(".csv.expected.json"))
      .sort()) {
      const st = JSON.parse(
        readFileSync(join(process.cwd(), "evals", "fixtures", "synthetic", bank, f), "utf8"),
      ) as ExpectedStatement;
      // Only synthetic data may ever be seeded.
      if (st.synthetic !== true) throw new Error(`${bank}/${f} is not marked synthetic`);
      out.push(st);
    }
  }
  return out;
}

const ALL_CATEGORIES = new Set(DEFAULT_CATEGORIES.map((c) => c.name));

/**
 * The demo stands in for the classifier: rows the rules/map decide get those
 * categories; the rest take the fixture's label as a "classifier" decision with
 * a stable pseudo-confidence, so some show up for review like a real import.
 */
function demoCategory(row: {
  rawDescriptor: string;
  kind: LedgerRow["kind"];
  amountCents: number;
  fx: LedgerRow["fx"];
  expectedCategory: string;
}) {
  const described = describeRow(row.rawDescriptor);
  const known = resolveDeterministic(
    { ...described, kind: row.kind, amountCents: row.amountCents, fx: row.fx },
    [],
    ALL_CATEGORIES,
  );
  if (known)
    return {
      categoryName: known.categoryName,
      categorySource: known.source,
      confidence: known.confidence,
    };
  const h = createHash("sha256").update(described.merchantName).digest()[0]!;
  return {
    categoryName: row.expectedCategory,
    categorySource: "llm" as const,
    confidence: 0.6 + (h % 38) / 100,
  };
}

/** Alex's monthly budgets: one runs over in the latest month, the rest stay within. */
const DEMO_BUDGETS: Record<string, number> = {
  Dining: 30_000,
  Groceries: 15_000,
  Transport: 20_000,
  Shopping: 25_000,
};

export type SeedResult = {
  statements: number;
  cards: number;
  bankAccounts: number;
  transactions: number;
  reconciled: number;
  /** Transfer legs paired across accounts (IMP-10). */
  paired: number;
};

/**
 * Fills a workspace with the fictional "Alex Tan" (12 months of DBS + UOB card
 * statements, and a POSB and a UOB One account) through the same write path as
 * a real import: PII firewall, envelope encryption, dedupe keys and transfer
 * pairing. Idempotent.
 */
export async function seedDemoWorkspace(
  db: AppDb,
  userId: string,
  keys: MasterKeys,
): Promise<SeedResult> {
  const fixtures = loadFixtureStatements();
  return withUser(db, userId, async (tx) => {
    const crypto = await getUserCrypto(tx, userId, keys);
    const categoryIds = await ensureDefaultCategories(tx, userId);
    const result: SeedResult = {
      statements: fixtures.length,
      cards: 0,
      bankAccounts: 0,
      transactions: 0,
      reconciled: 0,
      paired: 0,
    };
    const cardIds = new Set<string>();
    const bankIds = new Set<string>();
    for (const st of fixtures) {
      const kind = st.kind ?? "card";
      for (const card of st.cards) {
        const accountId = await upsertAccount(tx, userId, {
          bank: st.bank,
          productName: card.productName,
          ordinal: card.ordinal,
          kind,
        });
        (kind === "card" ? cardIds : bankIds).add(accountId);
        const r = await insertCardStatement(
          tx,
          crypto,
          {
            bank: st.bank,
            accountId,
            productName: card.productName,
            ordinal: card.ordinal,
            statementDate: st.statementDate,
            dueDate: st.dueDate ?? null,
            minimumPaymentCents: st.minimumPaymentCents ?? null,
            previousBalanceCents: card.previousBalanceCents,
            totalCents: card.totalCents,
            rows: card.rows.map((row) => ({ ...row, ...demoCategory(row) })),
          },
          categoryIds,
        );
        result.transactions += r.inserted;
        if (r.reconciled) result.reconciled++;
      }
    }
    result.cards = cardIds.size;
    result.bankAccounts = bankIds.size;
    result.paired = (await pairTransfers(tx)).pairs;
    await tx
      .insert(budgets)
      .values(
        Object.entries(DEMO_BUDGETS).map(([name, monthlyAmountCents]) => ({
          userId,
          categoryId: categoryIds.get(name)!,
          monthlyAmountCents,
        })),
      )
      .onConflictDoNothing();
    return result;
  });
}
