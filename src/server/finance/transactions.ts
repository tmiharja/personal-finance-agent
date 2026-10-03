import type { TxnKind } from "@/lib/kinds";
import { and, desc, eq, gte, ilike, inArray, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { accounts, categories, transactions } from "@/db/schema";
import { withUser } from "@/db/with-user";
import type { MasterKeys } from "@/server/crypto/envelope";
import { getUserCrypto } from "@/server/crypto/user-keys";
import { LOW_CONFIDENCE } from "@/server/categorise/categorise";

/**
 * The Transactions screen (PRD §6.7) and the "View N transactions" links Ask
 * produces share one filter, carried in the URL. Every query runs under the
 * user's RLS scope; descriptors are decrypted for the visible page only.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const PAGE_SIZE = 50;

export const txnFilterSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  account: z.uuid().optional(),
  /** Category name (stable across the UI and Ask). */
  category: z.string().min(1).max(60).optional(),
  /** Exact merchant name, case-insensitive. */
  merchant: z.string().min(1).max(80).optional(),
  /** Merchant name contains. Descriptors are encrypted, so search covers merchant names. */
  q: z.string().min(1).max(60).optional(),
  /** Only rows whose category needs a look (uncategorised or low confidence). */
  review: z.literal("1").optional(),
  /** Spend view: charges, refunds and fees only (no card payments or cashback). */
  spend: z.literal("1").optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

export type TxnFilter = z.output<typeof txnFilterSchema>;

/** Parses search params leniently: an invalid value is dropped, never an error page. */
export function parseTxnFilter(params: Record<string, string | string[] | undefined>): TxnFilter {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value === undefined || value === "") continue;
    const one = txnFilterSchema.shape[k as keyof TxnFilter]?.safeParse(value);
    if (one?.success) flat[k] = value;
  }
  return txnFilterSchema.parse(flat);
}

export function filterHref(filter: Partial<TxnFilter>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined || v === null || (k === "page" && v === 1)) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return `/app/transactions${qs ? `?${qs}` : ""}`;
}

/** Rows whose category the user may need to check: purchases, refunds and money in. */
const REVIEW_KINDS = ["charge", "refund", "income"] as const;

export const REVIEW_SQL = sql`(${categories.name} = 'Uncategorised' or ${transactions.categoryId} is null or (${transactions.categorySource} = 'llm' and coalesce(${transactions.confidence}, 0) < ${LOW_CONFIDENCE}))`;

function conditions(f: TxnFilter): SQL[] {
  const where: SQL[] = [];
  if (f.from) where.push(gte(transactions.txnDate, f.from));
  if (f.to) where.push(lte(transactions.txnDate, f.to));
  if (f.account) where.push(eq(transactions.accountId, f.account));
  if (f.category) where.push(eq(categories.name, f.category));
  if (f.merchant) where.push(sql`lower(${transactions.merchantName}) = lower(${f.merchant})`);
  if (f.q) where.push(ilike(transactions.merchantName, `%${f.q.replace(/[%_\\]/g, "\\$&")}%`));
  if (f.review) {
    where.push(REVIEW_SQL);
    where.push(inArray(transactions.kind, [...REVIEW_KINDS]));
    where.push(eq(transactions.isTransfer, false));
  }
  if (f.spend) {
    where.push(inArray(transactions.kind, ["charge", "refund", "fee"]));
    where.push(eq(transactions.isTransfer, false));
  }
  return where;
}

export type TxnRow = {
  id: string;
  txnDate: string;
  postDate: string | null;
  amountCents: number;
  fx: { currency: string | null; amount: string } | null;
  descriptor: string;
  merchantName: string | null;
  kind: TxnKind;
  categoryId: string | null;
  categoryName: string;
  categorySource: "rule" | "map" | "llm" | "user" | "system" | null;
  confidence: number | null;
  review: boolean;
  /** Matched with its other leg in another of your accounts (IMP-10): not editable. */
  paired: boolean;
  card: string;
};

export type TxnPage = {
  rows: TxnRow[];
  total: number;
  /** Net sum of every matching row (not just this page), signed. */
  totalCents: number;
  page: number;
  pages: number;
};

export async function listTransactions(
  db: AppDb,
  userId: string,
  keys: MasterKeys,
  filter: TxnFilter,
): Promise<TxnPage> {
  return withUser(db, userId, async (tx) => {
    const where = and(...conditions(filter));
    const base = tx
      .select({
        n: sql<number>`count(*)::int`,
        cents: sql<string>`coalesce(sum(${transactions.amountCents}), 0)::text`,
      })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(where);
    const [agg] = await base;
    const total = agg?.n ?? 0;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(filter.page, pages);
    const rows = await tx
      .select({
        id: transactions.id,
        txnDate: transactions.txnDate,
        postDate: transactions.postDate,
        amountCents: transactions.amountCents,
        fxAmount: transactions.fxAmount,
        fxCurrency: transactions.fxCurrency,
        descriptorEnc: transactions.descriptorEnc,
        merchantName: transactions.merchantName,
        kind: transactions.kind,
        categoryId: transactions.categoryId,
        categoryName: categories.name,
        categorySource: transactions.categorySource,
        confidence: transactions.confidence,
        review: sql<boolean>`${REVIEW_SQL}`,
        isTransfer: transactions.isTransfer,
        pairId: transactions.transferPairId,
        productName: accounts.productName,
        ordinal: accounts.ordinal,
      })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(where)
      .orderBy(desc(transactions.txnDate), desc(transactions.createdAt), transactions.id)
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE);
    const crypto = rows.length ? await getUserCrypto(tx, userId, keys) : null;
    return {
      rows: rows.map((r) => ({
        id: r.id,
        txnDate: r.txnDate,
        postDate: r.postDate,
        amountCents: r.amountCents,
        fx: r.fxAmount ? { currency: r.fxCurrency, amount: r.fxAmount } : null,
        descriptor: crypto!.decrypt("transactions.descriptor", r.descriptorEnc),
        merchantName: r.merchantName,
        kind: r.kind,
        categoryId: r.categoryId,
        categoryName: r.categoryName ?? "Uncategorised",
        categorySource: r.categorySource,
        confidence: r.confidence,
        review:
          (REVIEW_KINDS as readonly string[]).includes(r.kind) &&
          !r.isTransfer &&
          Boolean(r.review),
        card: r.ordinal > 1 ? `${r.productName} (${r.ordinal})` : r.productName,
        paired: r.pairId !== null,
      })),
      total,
      totalCents: Number(agg?.cents ?? 0),
      page,
      pages,
    };
  });
}

export type CategoryOption = { id: string; name: string; kind: string };
export type CardOption = { id: string; name: string };

/** Visible categories for pickers, in taxonomy order, plus the user's cards. */
export async function listFilterOptions(
  db: AppDb,
  userId: string,
): Promise<{ categories: CategoryOption[]; cards: CardOption[] }> {
  return withUser(db, userId, async (tx) => {
    const cats = await tx
      .select({ id: categories.id, name: categories.name, kind: categories.kind })
      .from(categories)
      .where(eq(categories.hidden, false))
      .orderBy(categories.sort, categories.name);
    const cards = await tx
      .select({ id: accounts.id, productName: accounts.productName, ordinal: accounts.ordinal })
      .from(accounts)
      .orderBy(accounts.bank, accounts.productName, accounts.ordinal);
    return {
      categories: cats,
      cards: cards.map((c) => ({
        id: c.id,
        name: c.ordinal > 1 ? `${c.productName} (${c.ordinal})` : c.productName,
      })),
    };
  });
}

export class TxnError extends Error {
  constructor(readonly code: "transaction_not_found" | "invalid_category" | "not_categorisable") {
    super(`Transaction error: ${code}`);
    this.name = "TxnError";
  }
}

/** Kinds whose category comes from the row itself, never from the user. */
export { FIXED_KINDS } from "@/lib/kinds";

/** How many rows need a category check (the Transactions "To review" chip). */
export async function countToReview(db: AppDb, userId: string): Promise<number> {
  return withUser(db, userId, async (tx) => {
    const [r] = sqlRows<{ n: number }>(
      await tx.execute(sql`
        select count(*)::int as n from transactions
        left join categories on categories.id = transactions.category_id
        where transactions.kind in ('charge', 'refund', 'income') and not transactions.is_transfer
          and ${REVIEW_SQL}`),
    );
    return r?.n ?? 0;
  });
}
