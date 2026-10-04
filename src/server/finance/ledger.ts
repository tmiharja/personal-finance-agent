import { and, eq, inArray, sql } from "drizzle-orm";
import { sqlRows } from "@/db/rows";
import { accounts, categories, statements, transactions } from "@/db/schema";
import type { Tx } from "@/db/with-user";
import type { CategorySource } from "@/server/categorise/categorise";
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
  { name: "Cash", kind: "expense" },
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

type AccountKind = (typeof accounts.$inferInsert)["kind"];

type AccountRef = {
  bank: Bank;
  productName: string;
  ordinal?: number;
  /** HMAC of the card/account number (see accounts.identity_key); null if the file had none. */
  identityKey?: string | null;
};

type Resolution = { id: string; adopt: boolean } | { id: null; ordinal: number };

/**
 * Which stored account a statement section belongs to. With a number digest: the
 * account holding that digest, else one of the same product that has none yet
 * (created before digests, at the same ordinal), else a new account at the next
 * free ordinal, so two same-named cards or accounts never merge. Without one:
 * bank + product name + ordinal, as before.
 */
async function resolveAccount(tx: Tx, ref: AccountRef): Promise<Resolution> {
  const ordinal = ref.ordinal ?? 1;
  if (ref.identityKey) {
    const [byKey] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.identityKey, ref.identityKey));
    if (byKey) return { id: byKey.id, adopt: false };
  }
  const same = await tx
    .select({ id: accounts.id, ordinal: accounts.ordinal, key: accounts.identityKey })
    .from(accounts)
    .where(and(eq(accounts.bank, ref.bank), eq(accounts.productName, ref.productName)))
    .orderBy(accounts.ordinal);
  const atOrdinal = same.find((a) => a.ordinal === ordinal);
  if (!ref.identityKey)
    return atOrdinal ? { id: atOrdinal.id, adopt: false } : { id: null, ordinal };
  if (atOrdinal && atOrdinal.key === null) return { id: atOrdinal.id, adopt: true };
  return {
    id: null,
    ordinal: atOrdinal ? Math.max(...same.map((a) => a.ordinal)) + 1 : ordinal,
  };
}

/**
 * For a section read without a number (the AI fallback): the digest of the stored
 * account it resolves to by name and ordinal, so its rows dedupe against the rows
 * a parser imported for that account.
 */
export async function storedIdentityKey(tx: Tx, ref: AccountRef): Promise<string | null> {
  const [a] = await tx
    .select({ key: accounts.identityKey })
    .from(accounts)
    .where(
      and(
        eq(accounts.bank, ref.bank),
        eq(accounts.productName, ref.productName),
        eq(accounts.ordinal, ref.ordinal ?? 1),
      ),
    );
  return a?.key ?? null;
}

/** The stored account for a statement section, or null if importing it would create one. */
export async function findAccount(tx: Tx, ref: AccountRef): Promise<string | null> {
  return (await resolveAccount(tx, ref)).id;
}

/** A card or bank account: product name as printed, plus a number digest when the file has one. */
export async function upsertAccount(
  tx: Tx,
  userId: string,
  card: AccountRef & { kind: AccountKind },
): Promise<string> {
  assertNoPii({ productName: card.productName });
  const found = await resolveAccount(tx, card);
  if ("adopt" in found) {
    if (found.adopt)
      await tx
        .update(accounts)
        .set({ identityKey: card.identityKey })
        .where(eq(accounts.id, found.id));
    return found.id;
  }
  const [row] = await tx
    .insert(accounts)
    .values({
      userId,
      bank: card.bank,
      kind: card.kind,
      productName: card.productName,
      ordinal: found.ordinal,
      identityKey: card.identityKey ?? null,
    })
    .returning({ id: accounts.id });
  return row!.id;
}

export const upsertCardAccount = (
  tx: Tx,
  userId: string,
  card: { bank: Bank; productName: string; ordinal?: number },
) => upsertAccount(tx, userId, { ...card, kind: "card" });

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
  categorySource?: CategorySource | null;
  confidence?: number | null;
};

export type CardIdentity = {
  bank: Bank;
  productName: string;
  ordinal: number;
  /** Number digest (accounts.identity_key), when the file printed a number. */
  identityKey?: string | null;
};

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
  categorySource?: CategorySource | null;
  confidence?: number | null;
};

/** The sanitised descriptor and merchant name a raw row will be stored with. */
export function describeRow(
  rawDescriptor: string,
  pii: PiiContext = {},
): { descriptor: string; merchantName: string } {
  const descriptor = sanitiseDescriptor(rawDescriptor, pii);
  return { descriptor, merchantName: normaliseMerchant(descriptor) };
}

/** Categories every import can set without a classifier (Phase 1b adds the rest). */
const KIND_CATEGORY: Partial<Record<TxnKind, string>> = {
  card_payment: "Transfers",
  transfer: "Transfers",
  fee: "Fees & Charges",
  cashback: "Cashback & Rewards",
};

/** Rows that are never spend or income, whatever their category (PRD IMP-10). */
export const isTransferKind = (kind: TxnKind) => kind === "card_payment" || kind === "transfer";

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
    const { descriptor, merchantName } = describeRow(r.rawDescriptor, pii);
    assertNoPii({ descriptor, merchantName }, pii);
    // The account: its number digest when known (two same-named accounts stay
    // apart), else product name + ordinal.
    const account = card.identityKey
      ? [`key:${card.identityKey}`]
      : [card.productName, card.ordinal];
    const identity = [card.bank, ...account, r.txnDate, r.postDate, r.amountCents, descriptor];
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
      // Explicit null (e.g. "Uncategorised" from the categoriser) stays null.
      categorySource: r.categoryName
        ? r.categorySource === undefined
          ? "system"
          : r.categorySource
        : KIND_CATEGORY[r.kind]
          ? "system"
          : null,
      confidence: r.categoryName ? (r.confidence ?? null) : KIND_CATEGORY[r.kind] ? 1 : null,
    };
  });
}

export type StatementSummary = {
  statementDate: string;
  dueDate: string | null;
  minimumPaymentCents: number | null;
  /** Signed like rows (+ owed, − held); null when the file printed no balances. */
  previousBalanceCents: number | null;
  totalCents: number | null;
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
): Promise<{ inserted: number; duplicates: number; reconciled: boolean | null }> {
  const rows = prepareRows(crypto, input, input.rows, pii);
  return insertPreparedStatement(tx, crypto, { ...input, rows }, categoryIds);
}

/** Writes one card section from rows that already passed prepareRows(). */
export async function insertPreparedStatement(
  tx: Tx,
  crypto: UserCrypto,
  input: PreparedStatementInput,
  categoryIds: Map<string, string>,
): Promise<{ inserted: number; duplicates: number; reconciled: boolean | null }> {
  const userId = crypto.userId;
  const summary = {
    dueDate: input.dueDate,
    minimumPaymentCents: input.minimumPaymentCents,
    previousBalanceCents: input.previousBalanceCents,
    totalCents: input.totalCents,
  };

  // Re-importing the same statement refreshes every summary field it prints; a file
  // that prints no balance (a CSV export) keeps the balances already verified from
  // the PDF. Whether it reconciles is recomputed below from the rows actually stored.
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
      set: {
        ...summary,
        previousBalanceCents: sql`coalesce(excluded.previous_balance_cents, ${statements.previousBalanceCents})`,
        totalCents: sql`coalesce(excluded.total_cents, ${statements.totalCents})`,
        ...(input.importId ? { importId: input.importId } : {}),
      },
    })
    .returning({
      id: statements.id,
      previous: statements.previousBalanceCents,
      total: statements.totalCents,
    });

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
      categorySource: r.categoryName
        ? r.categorySource === undefined
          ? ("system" as const)
          : r.categorySource
        : null,
      confidence: r.categoryName ? (r.confidence ?? null) : null,
      isTransfer: isTransferKind(r.kind),
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
  // No balances in the file (some CSV exports): nothing to check, so null, not a pass.
  // Against the balances now stored (this file's, or ones kept from an earlier file).
  const previous = stmt!.previous;
  const total = stmt!.total;
  const reconciled =
    previous === null || total === null ? null : previous + Number(sum!.cents) === total;
  await tx.update(statements).set({ reconciled }).where(eq(statements.id, stmt!.id));
  return { inserted: inserted.length, duplicates: values.length - inserted.length, reconciled };
}
