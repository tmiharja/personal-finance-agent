import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppDb } from "@/db/client";
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
  upsertCardAccount,
  type LedgerRow,
} from "@/server/finance/ledger";

/** Shape of evals/fixtures/synthetic/<bank>/*.expected.json (docs/statement-formats.md §3). */
type ExpectedStatement = {
  synthetic: true;
  bank: "DBS" | "UOB";
  statementDate: string;
  dueDate: string;
  minimumPaymentCents: number;
  cards: {
    productName: string;
    ordinal: number;
    previousBalanceCents: number;
    totalCents: number;
    rows: (Omit<LedgerRow, "categoryName" | "refNo"> & { expectedCategory: string })[];
  }[];
};

export const FIXTURES_DIR = join(process.cwd(), "evals", "fixtures", "synthetic");

export function loadFixtureStatements(dir = FIXTURES_DIR): ExpectedStatement[] {
  const out: ExpectedStatement[] = [];
  for (const bank of ["dbs", "uob"]) {
    for (const f of readdirSync(join(dir, bank))
      .filter((n) => n.endsWith(".expected.json"))
      .sort()) {
      const st = JSON.parse(readFileSync(join(dir, bank, f), "utf8")) as ExpectedStatement;
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

export type SeedResult = {
  statements: number;
  cards: number;
  transactions: number;
  reconciled: number;
};

/**
 * Fills a workspace with the fictional "Alex Tan" (12 months of DBS + UOB card
 * statements) through the same write path as a real import: PII firewall,
 * envelope encryption and dedupe keys. Idempotent.
 */
export async function seedDemoWorkspace(
  db: AppDb,
  userId: string,
  keys: MasterKeys,
  dir = FIXTURES_DIR,
): Promise<SeedResult> {
  const fixtures = loadFixtureStatements(dir);
  return withUser(db, userId, async (tx) => {
    const crypto = await getUserCrypto(tx, userId, keys);
    const categoryIds = await ensureDefaultCategories(tx, userId);
    const result: SeedResult = {
      statements: fixtures.length,
      cards: 0,
      transactions: 0,
      reconciled: 0,
    };
    const cardIds = new Set<string>();
    for (const st of fixtures) {
      for (const card of st.cards) {
        const accountId = await upsertCardAccount(tx, userId, {
          bank: st.bank,
          productName: card.productName,
          ordinal: card.ordinal,
        });
        cardIds.add(accountId);
        const r = await insertCardStatement(
          tx,
          crypto,
          {
            bank: st.bank,
            accountId,
            productName: card.productName,
            ordinal: card.ordinal,
            statementDate: st.statementDate,
            dueDate: st.dueDate,
            minimumPaymentCents: st.minimumPaymentCents,
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
    return result;
  });
}
