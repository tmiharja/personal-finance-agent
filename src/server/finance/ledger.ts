import { and, eq } from "drizzle-orm";
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

export type CardStatementInput = {
  bank: Bank;
  accountId: string;
  productName: string;
  ordinal: number;
  statementDate: string;
  dueDate: string | null;
  minimumPaymentCents: number | null;
  previousBalanceCents: number;
  totalCents: number;
  rows: LedgerRow[];
};

/**
 * Writes one card section of a statement. Every row passes the PII firewall
 * (sanitise, then assert) before encryption; a surviving identifier aborts the
 * whole transaction with a PiiViolation that names the field, never the value.
 */
export async function insertCardStatement(
  tx: Tx,
  crypto: UserCrypto,
  input: CardStatementInput,
  categoryIds: Map<string, string>,
  pii: PiiContext = {},
): Promise<{ inserted: number; duplicates: number; reconciled: boolean }> {
  const userId = crypto.userId;
  const reconciled =
    input.previousBalanceCents + input.rows.reduce((s, r) => s + r.amountCents, 0) ===
    input.totalCents;

  const [stmt] = await tx
    .insert(statements)
    .values({
      userId,
      accountId: input.accountId,
      statementDate: input.statementDate,
      dueDate: input.dueDate,
      minimumPaymentCents: input.minimumPaymentCents,
      previousBalanceCents: input.previousBalanceCents,
      totalCents: input.totalCents,
      reconciled,
    })
    .onConflictDoUpdate({
      target: [statements.userId, statements.accountId, statements.statementDate],
      set: { reconciled },
    })
    .returning({ id: statements.id });

  // Identical rows on one statement (e.g. a real duplicate charge) stay distinct.
  const seen = new Map<string, number>();
  const values = input.rows.map((r) => {
    const descriptor = sanitiseDescriptor(r.rawDescriptor, pii);
    const merchantName = normaliseMerchant(descriptor);
    assertNoPii({ descriptor, merchantName }, pii);
    const identity = [
      input.bank,
      input.productName,
      input.ordinal,
      r.txnDate,
      r.postDate,
      r.amountCents,
      descriptor,
    ];
    const occurrence = (seen.get(identity.join("|")) ?? 0) + 1;
    seen.set(identity.join("|"), occurrence);
    const categoryId =
      categoryIds.get(r.categoryName ?? "") ?? categoryIds.get("Uncategorised") ?? null;
    return {
      userId,
      accountId: input.accountId,
      statementId: stmt!.id,
      txnDate: r.txnDate,
      postDate: r.postDate,
      amountCents: r.amountCents,
      fxAmount: r.fx?.amount ?? null,
      fxCurrency: r.fx?.currency ?? null,
      descriptorEnc: crypto.encrypt("transactions.descriptor", descriptor),
      merchantName,
      kind: r.kind,
      categoryId,
      categorySource: r.categoryName ? ("system" as const) : null,
      isTransfer: r.kind === "card_payment",
      dedupeKey: crypto.dedupe([...identity, r.refNo, occurrence]),
    };
  });

  const inserted = values.length
    ? await tx
        .insert(transactions)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: transactions.id })
    : [];
  return { inserted: inserted.length, duplicates: values.length - inserted.length, reconciled };
}
