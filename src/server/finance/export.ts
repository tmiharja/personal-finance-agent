import { and, desc, eq, sql } from "drizzle-orm";
import { accounts, categories, transactions } from "@/db/schema";
import type { Tx } from "@/db/with-user";
import type { UserCrypto } from "@/server/crypto/envelope";
import { conditions, txnFilterSchema, type TxnFilter } from "./transactions";

/**
 * CSV export (PRD ACT-1 `export_csv`): the transactions matching a
 * Transactions filter, with the sanitised descriptor (the PII firewall ran on
 * import), never card or account numbers. Recorded in Activity like any change.
 */

export const EXPORT_MAX_ROWS = 20_000;

/** The Transactions filter without paging. */
export const exportFilterSchema = txnFilterSchema.omit({ page: true });

const HEADER = [
  "Date",
  "Posted",
  "Account",
  "Merchant",
  "Description",
  "Category",
  "Kind",
  "Amount (SGD)",
  "Foreign amount",
  "Tags",
];

/**
 * A text cell, quoted, and defused if a spreadsheet would read it as a formula
 * (CSV injection): a leading = + - @ tab or CR gets an apostrophe.
 */
export function csvText(value: string | null): string {
  const v = value ?? "";
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Signed like Overview: + money out, − money in. */
const amount = (cents: number) => (cents / 100).toFixed(2);

export async function countExport(tx: Tx, filter: Omit<TxnFilter, "page">): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(...conditions({ ...filter, page: 1 })));
  return r?.n ?? 0;
}

export async function exportCsv(
  tx: Tx,
  crypto: UserCrypto,
  filter: Omit<TxnFilter, "page">,
): Promise<{ csv: string; rows: number }> {
  const rows = await tx
    .select({
      txnDate: transactions.txnDate,
      postDate: transactions.postDate,
      product: accounts.productName,
      ordinal: accounts.ordinal,
      merchant: transactions.merchantName,
      descriptorEnc: transactions.descriptorEnc,
      category: categories.name,
      kind: transactions.kind,
      amountCents: transactions.amountCents,
      fxAmount: transactions.fxAmount,
      fxCurrency: transactions.fxCurrency,
      tags: sql<string | null>`(select string_agg(g.name, '; ' order by g.name)
        from transaction_tags tt join tags g on g.id = tt.tag_id where tt.transaction_id = ${transactions.id})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(...conditions({ ...filter, page: 1 })))
    .orderBy(desc(transactions.txnDate), transactions.id)
    .limit(EXPORT_MAX_ROWS);
  const lines = rows.map((r) =>
    [
      r.txnDate,
      r.postDate ?? "",
      csvText(r.ordinal > 1 ? `${r.product} (${r.ordinal})` : r.product),
      csvText(r.merchant),
      csvText(crypto.decrypt("transactions.descriptor", r.descriptorEnc)),
      csvText(r.category ?? "Uncategorised"),
      r.kind,
      amount(r.amountCents),
      r.fxAmount ? csvText(`${r.fxCurrency ?? ""} ${r.fxAmount}`.trim()) : "",
      csvText(r.tags),
    ].join(","),
  );
  // A BOM so Excel opens it as UTF-8.
  return { csv: `﻿${[HEADER.join(","), ...lines].join("\r\n")}\r\n`, rows: rows.length };
}
