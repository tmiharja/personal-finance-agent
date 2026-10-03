import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppDb } from "@/db/client";
import { withUser } from "@/db/with-user";
import type { MasterKeys } from "@/server/crypto/envelope";
import { getUserCrypto } from "@/server/crypto/user-keys";
import {
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
            rows: card.rows.map((row) => ({ ...row, categoryName: row.expectedCategory })),
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
