import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { TXN_KINDS } from "../../lib/kinds";
import { user } from "./auth";

/**
 * Finance tables. Every user-owned table:
 *  - carries `user_id`;
 *  - has Row-Level Security with one policy for the `app_user` role:
 *    rows are visible and writable only when user_id = current_setting('app.user_id').
 *
 * App code reaches these tables only through `withUser()` (src/db/with-user.ts), which
 * opens a transaction, sets app.user_id from the authenticated session and switches to
 * `app_user` (no BYPASSRLS). The model never supplies a user id.
 *
 * PII (docs/PRD.md §7.1a): no card/account numbers, names or addresses are stored.
 * A card is identified by bank + product name as printed (+ ordinal).
 * Columns ending in `_enc` hold AES-256-GCM ciphertext under the user's data key.
 */

// Created idempotently in drizzle/0000_roles.sql (roles are cluster-wide), hence .existing().
export const appUser = pgRole("app_user").existing();

const ownRows = sql`user_id = current_setting('app.user_id', true)`;

/**
 * A reference column must point at a row the current user can see. Foreign-key
 * checks ignore RLS, so without this a user could attach their row to another
 * user's id. The subquery itself runs under the parent table's RLS, so only the
 * user's own rows can match.
 */
type Ref = readonly [column: string, parent: string];
const refCheck = (table: string, [column, parent]: Ref) =>
  sql.raw(
    `(${table}.${column} is null or exists (select 1 from ${parent} p where p.id = ${table}.${column}))`,
  );

const rls = (table: string, refs: readonly Ref[] = [], extra: string[] = []) => {
  const checks = [...refs.map((r) => refCheck(table, r)), ...extra.map((e) => sql.raw(e))];
  return pgPolicy(`${table}_own_rows`, {
    as: "permissive",
    for: "all",
    to: appUser,
    using: ownRows,
    withCheck: checks.length ? sql`${ownRows} and ${sql.join(checks, sql` and `)}` : ownRows,
  });
};

const userId = () =>
  text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const id = () => uuid("id").primaryKey().defaultRandom();

// ------------------------------------------------------------------ enums

export const bankEnum = pgEnum("bank", ["DBS", "UOB", "OCBC"]);
export const accountKindEnum = pgEnum("account_kind", ["card", "deposit"]);
export const importStatusEnum = pgEnum("import_status", [
  "previewed",
  "committed",
  "expired",
  "failed",
  "discarded",
]);
export const txnKindEnum = pgEnum("txn_kind", TXN_KINDS);
export const categoryKindEnum = pgEnum("category_kind", [
  "expense",
  "income",
  "transfer",
  "system",
]);
export const categorySourceEnum = pgEnum("category_source", [
  "rule",
  "map",
  "llm",
  "user",
  "system",
]);
export const ruleMatchEnum = pgEnum("rule_match", ["merchant", "descriptor_contains"]);
export const cadenceEnum = pgEnum("cadence", ["weekly", "monthly", "quarterly", "annual"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "active",
  "possibly_cancelled",
  "overdue",
  "ignored",
]);
export const billSourceEnum = pgEnum("bill_source", ["detected", "manual", "statement"]);
export const billStatusEnum = pgEnum("bill_status", ["upcoming", "paid", "overdue"]);
export const alertTypeEnum = pgEnum("alert_type", [
  "price_increase",
  "trial_conversion",
  "unusual_amount",
  "first_time_merchant",
  "duplicate_charge",
  "foreign_charge",
  "card_fee",
  "bill_due",
]);
export const alertStatusEnum = pgEnum("alert_status", ["open", "dismissed", "expected"]);
// ACT-1 allowlist. Anything else is rejected before it is stored.
export const actionTypeEnum = pgEnum("action_type", [
  "commit_import",
  "create_rule",
  "update_rule",
  "delete_rule",
  "recategorise_transactions",
  "tag_transactions",
  "mark_transfer",
  "dismiss_alert",
  "mark_alert_expected",
  "set_subscription_status",
  "add_bill",
  "update_bill",
  "set_budget",
  "export_csv",
]);
export const proposalStatusEnum = pgEnum("proposal_status", [
  "pending",
  "approved",
  "executed",
  "rejected",
  "expired",
  "stale",
  "failed",
]);
export const actorEnum = pgEnum("actor", ["agent", "detector", "user", "system"]);
export const auditEventEnum = pgEnum("audit_event", [
  "proposed",
  "approved",
  "rejected",
  "executed",
  "failed",
  "expired",
  "undone",
]);

// ------------------------------------------------------------------ keys

/** The user's data key (DEK), wrapped by the master key. Never stored unwrapped. */
export const userKeys = pgTable(
  "user_keys",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    wrappedDek: text("wrapped_dek").notNull(),
    masterKeyId: smallint("master_key_id").notNull(),
    createdAt: createdAt(),
  },
  () => [rls("user_keys")],
);

// ------------------------------------------------------------------ ledger

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    userId: userId(),
    bank: bankEnum("bank").notNull(),
    kind: accountKindEnum("kind").notNull(),
    /** Product name as printed, e.g. "UOB SAMPLE CASHBACK". The only card identifier. */
    productName: text("product_name").notNull(),
    /** 1, 2… only when one statement has two cards with the same product name. */
    ordinal: smallint("ordinal").notNull().default(1),
    nicknameEnc: text("nickname_enc"),
    currency: char("currency", { length: 3 }).notNull().default("SGD"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("accounts_identity_uq").on(t.userId, t.bank, t.productName, t.ordinal),
    rls("accounts"),
  ],
);

export const imports = pgTable(
  "imports",
  {
    id: id(),
    userId: userId(),
    /** SHA-256 of the uploaded file: blocks exact re-uploads. The file itself is discarded. */
    fileSha256: char("file_sha256", { length: 64 }).notNull(),
    bank: bankEnum("bank").notNull(),
    parserVersion: text("parser_version").notNull(),
    statementDate: date("statement_date").notNull(),
    status: importStatusEnum("status").notNull().default("previewed"),
    /**
     * The parsed statement after the PII firewall (sanitised descriptors, dedupe
     * keys; no reference numbers or names), encrypted. Committed only on approval.
     */
    previewEnc: text("preview_enc"),
    /** Counts and totals only (no descriptors): what the preview card shows. */
    summary: jsonb("summary"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("imports_file_uq").on(t.userId, t.fileSha256), rls("imports")],
);

/**
 * One row per card or bank-account section of a statement. Balances are signed
 * like transactions (+ owed to the bank, − money held), so for every kind
 * `previous_balance + Σ rows = total`. A bank account holding S$5,000 has a
 * total of −500000. Null balances: the file (some CSV exports) had none.
 */
export const statements = pgTable(
  "statements",
  {
    id: id(),
    userId: userId(),
    importId: uuid("import_id").references(() => imports.id, { onDelete: "set null" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    statementDate: date("statement_date").notNull(),
    dueDate: date("due_date"),
    minimumPaymentCents: bigint("minimum_payment_cents", { mode: "number" }),
    previousBalanceCents: bigint("previous_balance_cents", { mode: "number" }),
    totalCents: bigint("total_cents", { mode: "number" }),
    /** Null: nothing to reconcile against (no balances in the file). */
    reconciled: boolean("reconciled"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("statements_period_uq").on(t.userId, t.accountId, t.statementDate),
    rls("statements", [
      ["account_id", "accounts"],
      ["import_id", "imports"],
    ]),
  ],
);

export const categories = pgTable(
  "categories",
  {
    id: id(),
    userId: userId(),
    name: text("name").notNull(),
    kind: categoryKindEnum("kind").notNull(),
    hidden: boolean("hidden").notNull().default(false),
    sort: smallint("sort").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("categories_name_uq").on(t.userId, t.name), rls("categories")],
);

export const transactions = pgTable(
  "transactions",
  {
    id: id(),
    userId: userId(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    statementId: uuid("statement_id").references(() => statements.id, { onDelete: "set null" }),
    txnDate: date("txn_date").notNull(),
    postDate: date("post_date"),
    /** Signed, in minor units: + charge, − credit. */
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("SGD"),
    fxAmount: numeric("fx_amount", { precision: 18, scale: 2 }),
    fxCurrency: char("fx_currency", { length: 3 }),
    /** Sanitised descriptor (PII firewall applied), encrypted. */
    descriptorEnc: text("descriptor_enc").notNull(),
    /** Normalised merchant name, e.g. "Grab" — plaintext so spend can be grouped in SQL. */
    merchantName: text("merchant_name"),
    kind: txnKindEnum("kind").notNull(),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    categorySource: categorySourceEnum("category_source"),
    confidence: real("confidence"),
    isTransfer: boolean("is_transfer").notNull().default(false),
    /** The other leg of a transfer between your own accounts, once both are imported (IMP-10). */
    transferPairId: uuid("transfer_pair_id").references((): AnyPgColumn => transactions.id, {
      onDelete: "set null",
    }),
    /** The account money went to or came from, when known (e.g. the card a bank payment paid). */
    transferAccountId: uuid("transfer_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    /** HMAC under the user's dedupe key; reference numbers only ever enter this hash. */
    dedupeKey: char("dedupe_key", { length: 64 }).notNull(),
    /** Optimistic concurrency for proposals (ACT-6). */
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("transactions_dedupe_uq").on(t.userId, t.dedupeKey),
    index("transactions_user_date_idx").on(t.userId, t.txnDate),
    index("transactions_user_merchant_idx").on(t.userId, t.merchantName),
    rls(
      "transactions",
      [
        ["account_id", "accounts"],
        ["statement_id", "statements"],
        ["category_id", "categories"],
        ["transfer_account_id", "accounts"],
      ],
      [
        // A policy on transactions can't query transactions (infinite recursion), so the
        // pair's ownership is checked by a SECURITY DEFINER function (drizzle/0007).
        "(transactions.transfer_pair_id is null or app_owns_transaction(transactions.transfer_pair_id))",
      ],
    ),
  ],
);

export const tags = pgTable(
  "tags",
  { id: id(), userId: userId(), name: text("name").notNull(), createdAt: createdAt() },
  (t) => [uniqueIndex("tags_name_uq").on(t.userId, t.name), rls("tags")],
);

export const transactionTags = pgTable(
  "transaction_tags",
  {
    userId: userId(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.transactionId, t.tagId] }),
    rls("transaction_tags", [
      ["transaction_id", "transactions"],
      ["tag_id", "tags"],
    ]),
  ],
);

export const rules = pgTable(
  "rules",
  {
    id: id(),
    userId: userId(),
    match: ruleMatchEnum("match").notNull(),
    pattern: text("pattern").notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    priority: smallint("priority").notNull().default(100),
    createdViaProposal: uuid("created_via_proposal"),
    createdAt: createdAt(),
  },
  () => [rls("rules", [["category_id", "categories"]])],
);

/** Curated global merchant map (not user data): read-only for app_user, no RLS. */
export const merchantMap = pgTable("merchant_map", {
  id: id(),
  pattern: text("pattern").notNull().unique(),
  merchantName: text("merchant_name").notNull(),
  defaultCategory: text("default_category").notNull(),
});

// ------------------------------------------------------------------ detectors

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    userId: userId(),
    merchantName: text("merchant_name").notNull(),
    cadence: cadenceEnum("cadence").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("SGD"),
    lastChargeDate: date("last_charge_date"),
    nextExpectedDate: date("next_expected_date"),
    status: subscriptionStatusEnum("status").notNull().default("active"),
    /** Charges in the detected series. */
    charges: integer("charges").notNull().default(0),
    firstChargeDate: date("first_charge_date"),
    /** The price before the latest change, and when the new price started (DET-2). */
    previousAmountCents: bigint("previous_amount_cents", { mode: "number" }),
    priceChangedOn: date("price_changed_on"),
    /** The user chose to ignore it: detectors keep it, the screens hide it. */
    ignored: boolean("ignored").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("subscriptions_merchant_uq").on(t.userId, t.merchantName, t.cadence),
    rls("subscriptions"),
  ],
);

export const bills = pgTable(
  "bills",
  {
    id: id(),
    userId: userId(),
    payee: text("payee").notNull(),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    dueDate: date("due_date"),
    dueDay: smallint("due_day"),
    expectedAmountCents: bigint("expected_amount_cents", { mode: "number" }),
    source: billSourceEnum("source").notNull(),
    status: billStatusEnum("status").notNull().default("upcoming"),
    lastPaidOn: date("last_paid_on"),
    lastAmountCents: bigint("last_amount_cents", { mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bills_payee_uq").on(t.userId, t.payee, t.source),
    rls("bills", [["account_id", "accounts"]]),
  ],
);

export const alerts = pgTable(
  "alerts",
  {
    id: id(),
    userId: userId(),
    type: alertTypeEnum("type").notNull(),
    /** Plain-English reason built from structured data (no descriptors, no PII). */
    reason: text("reason").notNull(),
    transactionIds: uuid("transaction_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    status: alertStatusEnum("status").notNull().default("open"),
    /** (type, subject, period): keeps the daily detector run idempotent. */
    dedupeKey: text("dedupe_key").notNull(),
    /** The merchant or card the alert is about, and the date it refers to. */
    subject: text("subject"),
    occurredOn: date("occurred_on"),
    /** Structured figures behind the reason (amounts in cents, counts): for the UI and Ask. */
    details: jsonb("details")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("alerts_dedupe_uq").on(t.userId, t.dedupeKey),
    rls(
      "alerts",
      [],
      [
        "not exists (select 1 from unnest(alerts.transaction_ids) x(id) where not exists (select 1 from transactions t where t.id = x.id))",
      ],
    ),
  ],
);

export const budgets = pgTable(
  "budgets",
  {
    id: id(),
    userId: userId(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    monthlyAmountCents: bigint("monthly_amount_cents", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("budgets_category_uq").on(t.userId, t.categoryId),
    rls("budgets", [["category_id", "categories"]]),
  ],
);

// ------------------------------------------------------------------ approvals

export const proposedActions = pgTable(
  "proposed_actions",
  {
    id: id(),
    userId: userId(),
    type: actionTypeEnum("type").notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: char("payload_hash", { length: 64 }).notNull(),
    /** Deterministic, server-built preview (never model text). */
    preview: jsonb("preview").notNull(),
    /** Row versions the preview was built against (ACT-6). */
    baseVersions: jsonb("base_versions")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: proposalStatusEnum("status").notNull().default("pending"),
    proposer: actorEnum("proposer").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (t) => [
    index("proposed_actions_user_status_idx").on(t.userId, t.status),
    rls("proposed_actions"),
  ],
);

/** Append-only (a trigger blocks UPDATE/DELETE outside account deletion). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    userId: userId(),
    proposalId: uuid("proposal_id"),
    actor: actorEnum("actor").notNull(),
    event: auditEventEnum("event").notNull(),
    detail: jsonb("detail")
      .notNull()
      .default(sql`'{}'::jsonb`),
    inverse: jsonb("inverse"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_user_created_idx").on(t.userId, t.createdAt),
    rls("audit_log", [["proposal_id", "proposed_actions"]]),
  ],
);

/** LLM usage and cost per call (counts only). */
export const usage = pgTable(
  "usage",
  {
    id: id(),
    userId: userId(),
    route: text("route").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("usage_user_created_idx").on(t.userId, t.createdAt), rls("usage")],
);

// ------------------------------------------------------------------ system (owner only)

/**
 * Demo limits per visitor per day (PRD AUTH-6, §7.3). The key is an HMAC of the
 * client IP under a key that changes daily, so no IP address is stored and keys
 * can't be linked across days. No RLS and no grants: app_user can't read it.
 */
export const demoQuota = pgTable(
  "demo_quota",
  {
    key: char("key", { length: 64 }).notNull(),
    day: date("day").notNull(),
    workspaces: integer("workspaces").notNull().default(0),
    questions: integer("questions").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.day] })],
);

/** Monthly LLM cost of deleted users (demo workspaces), so the global breaker still counts it. */
export const llmSpendArchive = pgTable("llm_spend_archive", {
  month: date("month").primaryKey(),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull(),
});

/** Tables app_user may touch. Used by the grants migration test and the no-PII dump. */
export const USER_TABLES = [
  "user_keys",
  "accounts",
  "imports",
  "statements",
  "categories",
  "transactions",
  "tags",
  "transaction_tags",
  "rules",
  "subscriptions",
  "bills",
  "alerts",
  "budgets",
  "proposed_actions",
  "audit_log",
  "usage",
] as const;
