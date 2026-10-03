import { and, eq, inArray, sql } from "drizzle-orm";
import { sqlRows } from "@/db/rows";
import { accounts, categories, statements, transactions } from "@/db/schema";
import type { Tx } from "@/db/with-user";
import type { UserCrypto } from "@/server/crypto/envelope";
import { assertNoPii, sanitiseDescriptor, type PiiContext } from "@/server/pii/firewall";
import { normaliseMerchant } from "./merchant";

type Bank = (typeof accounts.$inferInsert)["bank"];
type TxnKind = (typeof transactions.$inferInsert)["kind"];
type CategoryKind = (typeof categories.$inferInsert)["kind"];

/** PRD CAT-1 starter taxonomy. */
export const DEFAULT_CATEGORIES: readonly { name: string; kind: CategoryKind }[] = [
  { name: "Dining", kind: "expense" },
  { name: "Groceries", kind: "expense" },
  { name: "Transport", kind: "expense" },
  { name: "Shopping", kind: "expense" },
  { name: "Bills & Utilities", kind: "expense" },
  { name: "Telco & Internet", kind: "expense" },
  { name: "Insurance", kind: "expense" },
  { name: "Health", kind: "expense" },
  { name: "Entertainment", kind: "expense" },
  { name: "Subscriptions", kind: "expense" },
  { name: "Travel", kind: "expense" },
  { name: "Education", kind: "expense" },
  { name: "Home", kind: "expense" },
  { name: "Fees & Charges", kind: "expense" },
  { name: "Gifts & Donations", kind: "expense" },
  { name: "Cashback & Rewards", kind: "income" },
  { name: "Income", kind: "income" },
  { name: "Transfers", kind: "transfer" },
  { name: "Uncategorised", kind: "system" },
];

export async function ensureDefaultCategories(
  tx: Tx,
  userId: string,
): Promise<Map<string, string>> {
  await tx
    .insert(categories)
    .values(DEFAULT_CATEGORIES.map((c, i) => ({ userId, name: c.name, kind: c.kind, sort: i })))
    .onConflictDoNothing();
  const rows = await tx.select({ id: categories.id, name: categories.name }).from(categories);
  return new Map(rows.map((r) => [r.name, r.id]));
}

export async function upsertCardAccount(
  tx: Tx,
  userId: string,
  card: { bank: Bank; productName: string; ordinal?: number },
): Promise<string> {
  const ordinal = card.ordinal ?? 1;
  assertNoPii({ productName: card.productName });
  await tx
    .insert(accounts)
    .values({ userId, bank: card.bank, kind: "card", productName: card.productName, ordinal })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.bank, card.bank),
        eq(accounts.productName, card.productName),
        eq(accounts.ordinal, ordinal),
      ),
    );
  return row!.id;
}

export type LedgerRow = {
  txnDate: string;
  postDate: string | null;
  amountCents: number;
  /** As printed. Sanitised here; never stored raw. */
  rawDescriptor: string;
  fx: { currency: string | null; amount: string } | null;
  kind: TxnKind;
  /** Statement reference number: only ever enters the dedupe hash. */
  refNo?: string | null;
  categoryName?: string;
};

export type CardIdentity = { bank: Bank; productName: string; ordinal: number };

/** A row after the PII firewall, ready to encrypt and store. */
export type PreparedRow = {
  txnDate: string;
  postDate: string | null;
  amountCents: number;
  /** Sanitised (PRD §7.1a). Encrypted when stored. */
  descriptor: string;
  merchantName: string;
  fx: { currency: string | null; amount: string } | null;
  kind: TxnKind;
  /** HMAC under the user's key; the reference number never leaves this function. */
  dedupeKey: string;
  categoryName?: string;
};

/** Categories every import can set without a classifier (Phase 1b adds the rest). */
const KIND_CATEGORY: Partial<Record<TxnKind, string>> = {
  card_payment: "Transfers",
  fee: "Fees & Charges",
  cashback: "Cashback & Rewards",
};

/**
 * The PII firewall step: sanitise each descriptor, normalise the merchant,
 * assert nothing identifying survives, and derive the dedupe key. A surviving
 * identifier throws a PiiViolation that names the field, never the value.
 */
export function prepareRows(
  crypto: UserCrypto,
  card: CardIdentity,
  rows: LedgerRow[],
  pii: PiiContext = {},
): PreparedRow[] {
  // Identical rows on one statement (e.g. a real duplicate charge) stay distinct.
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const descriptor = sanitiseDescriptor(r.rawDescriptor, pii);
    const merchantName = normaliseMerchant(descriptor);
    assertNoPii({ descriptor, merchantName }, pii);
    const identity = [
      card.bank,
      card.productName,
      card.ordinal,
      r.txnDate,
      r.postDate,
      r.amountCents,
      descriptor,
    ];
    const occurrence = (seen.get(identity.join("|")) ?? 0) + 1;
    seen.set(identity.join("|"), occurrence);
    return {
      txnDate: r.txnDate,
      postDate: r.postDate,
      amountCents: r.amountCents,
      descriptor,
      merchantName,
      fx: r.fx,
      kind: r.kind,
      dedupeKey: crypto.dedupe([...identity, r.refNo, occurrence]),
      categoryName: r.categoryName ?? KIND_CATEGORY[r.kind],
    };
  });
}

export type StatementSummary = {
  statementDate: string;
  dueDate: string | null;
  minimumPaymentCents: number | null;
  previousBalanceCents: number;
  totalCents: number;
};

export type CardStatementInput = CardIdentity &
  StatementSummary & {
    accountId: string;
    importId?: string | null;
    rows: LedgerRow[];
  };

export type PreparedStatementInput = CardIdentity &
  StatementSummary & {
    accountId: string;
    importId?: string | null;
    rows: PreparedRow[];
  };

/** Writes one card section of a statement from raw parsed rows. */
export async function insertCardStatement(
  tx: Tx,
  crypto: UserCrypto,
  input: CardStatementInput,
  categoryIds: Map<string, string>,
  pii: PiiContext = {},
): Promise<{ inserted: number; duplicates: number; reconciled: boolean }> {
  const rows = prepareRows(crypto, input, input.rows, pii);
  return insertPreparedStatement(tx, crypto, { ...input, rows }, categoryIds);
}

/** Writes one card section from rows that already passed prepareRows(). */
export async function insertPreparedStatement(
  tx: Tx,
  crypto: UserCrypto,
  input: PreparedStatementInput,
  categoryIds: Map<string, string>,
): Promise<{ inserted: number; duplicates: number; reconciled: boolean }> {
  const userId = crypto.userId;
  const summary = {
    dueDate: input.dueDate,
    minimumPaymentCents: input.minimumPaymentCents,
    previousBalanceCents: input.previousBalanceCents,
    totalCents: input.totalCents,
  };

  // Re-importing the same card statement refreshes every summary field; whether it
  // reconciles is recomputed below from the rows actually stored.
  const [stmt] = await tx
    .insert(statements)
    .values({
      userId,
      accountId: input.accountId,
      importId: input.importId ?? null,
      statementDate: input.statementDate,
      ...summary,
      reconciled: false,
    })
    .onConflictDoUpdate({
      target: [statements.userId, statements.accountId, statements.statementDate],
      set: { ...summary, ...(input.importId ? { importId: input.importId } : {}) },
    })
    .returning({ id: statements.id });

  const uncategorised = categoryIds.get("Uncategorised") ?? null;
  const values = input.rows.map((r) => {
    // Defence in depth: prepared rows are re-checked right before they are written.
    assertNoPii({ descriptor: r.descriptor, merchantName: r.merchantName });
    return {
      userId,
      accountId: input.accountId,
      statementId: stmt!.id,
      txnDate: r.txnDate,
      postDate: r.postDate,
      amountCents: r.amountCents,
      fxAmount: r.fx?.amount ?? null,
      fxCurrency: r.fx?.currency ?? null,
      descriptorEnc: crypto.encrypt("transactions.descriptor", r.descriptor),
      merchantName: r.merchantName,
      kind: r.kind,
      categoryId: (r.categoryName && categoryIds.get(r.categoryName)) || uncategorised,
      categorySource: r.categoryName ? ("system" as const) : null,
      isTransfer: r.kind === "card_payment",
      dedupeKey: r.dedupeKey,
    };
  });

  const inserted = values.length
    ? await tx
        .insert(transactions)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: transactions.id })
    : [];

  // Reconcile what is stored, not what was passed in. A statement's rows are those
  // linked to it plus its rows first imported from an overlapping statement
  // (matched by dedupe key, each counted once). A corrected re-import whose stored
  // rows no longer add up to the printed total is still flagged.
  const keys = input.rows.map((r) => r.dedupeKey);
  const ownRows = keys.length
    ? sql`statement_id = ${stmt!.id} or ${inArray(transactions.dedupeKey, keys)}`
    : sql`statement_id = ${stmt!.id}`;
  const [sum] = sqlRows<{ cents: number }>(
    await tx.execute(
      sql`select coalesce(sum(amount_cents), 0)::bigint as cents from transactions where ${ownRows}`,
    ),
  );
  const reconciled = input.previousBalanceCents + Number(sum!.cents) === input.totalCents;
  await tx.update(statements).set({ reconciled }).where(eq(statements.id, stmt!.id));
  return { inserted: inserted.length, duplicates: values.length - inserted.length, reconciled };
}
