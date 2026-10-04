import type { Bank } from "@/lib/banks";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { sqlRows } from "@/db/rows";
import { auditLog, imports, proposedActions, transactions } from "@/db/schema";
import { withUser, type Tx } from "@/db/with-user";
import type { MasterKeys, UserCrypto } from "@/server/crypto/envelope";
import { getUserCrypto } from "@/server/crypto/user-keys";
import {
  ensureDefaultCategories,
  insertPreparedStatement,
  prepareRows,
  findAccount,
  upsertAccount,
  type LedgerRow,
  type PreparedRow,
} from "@/server/finance/ledger";
import { needsReview, type Categorised } from "@/server/categorise/categorise";
import { categoriseStatement } from "@/server/categorise/context";
import { audit, canonical, expireIfDue, sha256 } from "@/server/actions/common";
import type { ActionPreview, ActionType, Proposer } from "@/server/actions/engine";
import { extractWithAi } from "@/server/ingest/fallback";
import { PdfError } from "@/server/ingest/pdf";
import {
  ParseError,
  parseStatementFile,
  type ParsedStatement,
  type ParseResult,
} from "@/server/ingest/parsers";
import { reconcileOutcome, recordParseOutcome } from "@/server/ingest/stats";
import { getLlm } from "@/server/llm/client";
import { budgetBlock, recordUsage } from "@/server/llm/usage";
import {
  countNewPairs,
  loadPairCandidates,
  matchTransfers,
  pairTransfers,
  type PairCandidate,
} from "@/server/finance/transfers";
import { longDate } from "@/lib/format";
import { logError, logEvent } from "@/server/log";
import { getEnv } from "@/env";

/**
 * Statement import (PRD IMP-1…IMP-14, ACT-6):
 *
 *   upload → parse (in memory) → PII firewall + dedupe keys → encrypted preview
 *          → `commit_import` proposal → user approves → ledger write + audit
 *
 * Nothing reaches the ledger until the user approves. The file is never stored:
 * only its SHA-256 (to block exact re-uploads) and the sanitised, encrypted preview.
 */

export const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_IMPORTS_PER_30_DAYS = 40;

export type ImportErrorCode =
  | "already_imported"
  | "rate_limited"
  | "proposal_not_found"
  | "proposal_not_pending"
  | "proposal_expired"
  | "preview_tampered";

export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(`Import error: ${code}`);
    this.name = "ImportError";
  }
}

/** One card, or one bank account (summary.kind "deposit"). */
export type PreviewCard = {
  productName: string;
  ordinal: number;
  isNewCard: boolean;
  /** Signed like rows: + owed, − held (a bank balance is negative). Null: none printed. */
  previousBalanceCents: number | null;
  totalCents: number | null;
  /** Null: no balances in the file, so nothing to check against. */
  reconciled: boolean | null;
  /** printed total − (previous balance + Σ rows); 0 when reconciled, null when unknown. */
  differenceCents: number | null;
  counts: {
    rows: number;
    newRows: number;
    duplicates: number;
    cardPayments: number;
    refunds: number;
    fees: number;
    cashback: number;
    foreignCurrency: number;
    /** Bank accounts: credits that aren't refunds, and moves between your own accounts. */
    income?: number;
    transfers?: number;
  };
  chargesCents: number;
  /** Bank accounts: Σ income rows (as a positive amount). */
  incomeCents?: number;
};

/** Counts and totals only: safe to store unencrypted and to put in a proposal. */
export type ImportSummary = {
  bank: Bank;
  /** Absent on previews made before Phase 2b: those are card statements. */
  kind?: "card" | "deposit";
  parserVersion: string;
  statementDate: string;
  dueDate: string | null;
  minimumPaymentCents: number | null;
  statementTotalCents: number | null;
  totalsMatch: boolean | null;
  allReconciled: boolean;
  cards: PreviewCard[];
  /** Rows this import will pair with your other accounts (PRD IMP-10). */
  pairing?: { cardPayments: number; transfers: number; linkedCardPayments: number };
  /** Category outcome for the rows this import will add (duplicates excluded). */
  categories: {
    toReview: number;
    bySource: Record<"system" | "rule" | "map" | "llm" | "none", number>;
  };
  warnings: string[];
};

export type PreviewRow = Pick<
  PreparedRow,
  "txnDate" | "postDate" | "amountCents" | "descriptor" | "fx" | "kind"
> & {
  duplicate: boolean;
  categoryName: string;
  /** Uncategorised, or a classifier decision below the confidence bar (PRD CAT-4). */
  review: boolean;
};

function previewRow(r: PreparedRow, duplicate: boolean): PreviewRow {
  const categoryName = r.categoryName ?? "Uncategorised";
  return {
    txnDate: r.txnDate,
    postDate: r.postDate,
    amountCents: r.amountCents,
    descriptor: r.descriptor,
    fx: r.fx,
    kind: r.kind,
    duplicate,
    categoryName,
    review: needsReview({
      categoryName,
      source: r.categorySource ?? null,
      confidence: r.confidence ?? null,
    }),
  };
}

export type ImportPreview = {
  importId: string;
  proposalId: string;
  status: "previewed" | "committed" | "expired" | "failed" | "discarded";
  expiresAt: string | null;
  summary: ImportSummary;
  /** Sanitised rows per card, for the user's own review screen. */
  rows: PreviewRow[][];
};

/** What is encrypted into imports.preview_enc. */
type StoredPreview = {
  statement: Omit<ParsedStatement, "cards"> & {
    cards: (Omit<ParsedStatement["cards"][number], "rows"> & {
      rows: PreparedRow[];
      /** HMAC of the card/account number; the number itself is never kept. */
      identityKey?: string | null;
    })[];
  };
};

async function existingDedupeKeys(tx: Tx, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await tx
    .select({ k: transactions.dedupeKey })
    .from(transactions)
    .where(inArray(transactions.dedupeKey, keys));
  return new Set(rows.map((r) => r.k));
}

type StatementCategoriesLike = { byCard: Categorised[][]; warnings: string[] };

function withCategory<R extends ParsedStatement["cards"][number]["rows"][number]>(
  row: R,
  c: Categorised | undefined,
): R & Partial<Pick<LedgerRow, "categoryName" | "categorySource" | "confidence">> {
  if (!c) return row;
  return {
    ...row,
    categoryName: c.categoryName,
    categorySource: c.source,
    confidence: c.confidence,
  };
}

function categoryCounts(rows: PreparedRow[]): ImportSummary["categories"] {
  const bySource = { system: 0, rule: 0, map: 0, llm: 0, none: 0 };
  let toReview = 0;
  for (const r of rows) {
    const source = r.categorySource ?? null;
    bySource[source ?? "none"]++;
    const categoryName = r.categoryName ?? "Uncategorised";
    if (
      r.kind !== "card_payment" &&
      needsReview({ categoryName, source, confidence: r.confidence ?? null })
    ) {
      toReview++;
    }
  }
  return { toReview, bySource };
}

async function buildPreview(
  tx: Tx,
  crypto: UserCrypto,
  statement: ParsedStatement,
  names: string[],
  categorised: StatementCategoriesLike | null,
  accountRefs: readonly (string | null)[] = [],
): Promise<{ stored: StoredPreview; summary: ImportSummary; rows: PreviewRow[][] }> {
  // Transfer pairing, counted (not written) for the preview: this statement's new
  // rows against everything already in the ledger.
  const existing = await loadPairCandidates(tx);
  const newCandidates: PairCandidate[] = [];
  const newCardStatements: typeof existing.cardStatements = [];
  const storedCards: StoredPreview["statement"]["cards"] = [];
  const cards: PreviewCard[] = [];
  const rows: PreviewRow[][] = [];

  const freshRows: PreparedRow[] = [];
  for (const [cardIndex, card] of statement.cards.entries()) {
    const cats = categorised?.byCard[cardIndex];
    // The number becomes a one-way, per-user digest here and is dropped.
    const number = accountRefs[cardIndex]?.replace(/\D/g, "");
    const identityKey = number ? crypto.dedupe(["account", statement.bank, number]) : null;
    const ref = { bank: statement.bank, ...card, identityKey };
    const existingId = await findAccount(tx, ref);
    const prepared = prepareRows(
      crypto,
      ref,
      card.rows.map((r, i) => withCategory(r, cats?.[i])),
      { names },
    );
    const dupes = await existingDedupeKeys(
      tx,
      prepared.map((r) => r.dedupeKey),
    );
    const sum = card.rows.reduce((s, r) => s + r.amountCents, 0);
    const balances = card.previousBalanceCents !== null && card.totalCents !== null;
    const count = (kind: PreparedRow["kind"]) => prepared.filter((r) => r.kind === kind).length;
    storedCards.push({ ...card, rows: prepared, identityKey });
    // Duplicates are skipped on approval, so they don't count towards "to review".
    freshRows.push(...prepared.filter((r) => !dupes.has(r.dedupeKey)));
    const accountId = existingId ?? `new:${cardIndex}`;
    prepared.forEach((r, i) => {
      if (!dupes.has(r.dedupeKey))
        newCandidates.push({
          id: `new:${cardIndex}:${i}`,
          accountId,
          accountKind: statement.kind,
          bank: statement.bank,
          date: r.txnDate,
          cents: r.amountCents,
          kind: r.kind,
          merchant: r.merchantName,
        });
    });
    if (statement.kind === "card")
      newCardStatements.push({
        accountId,
        bank: statement.bank,
        statementDate: statement.statementDate,
        totalCents: card.totalCents,
      });
    cards.push({
      productName: card.productName,
      ordinal: card.ordinal,
      isNewCard: existingId === null,
      previousBalanceCents: card.previousBalanceCents,
      totalCents: card.totalCents,
      reconciled: card.reconciled,
      differenceCents: balances ? card.totalCents! - (card.previousBalanceCents! + sum) : null,
      counts: {
        rows: prepared.length,
        newRows: prepared.filter((r) => !dupes.has(r.dedupeKey)).length,
        duplicates: prepared.filter((r) => dupes.has(r.dedupeKey)).length,
        cardPayments: count("card_payment"),
        refunds: count("refund"),
        fees: count("fee"),
        cashback: count("cashback"),
        foreignCurrency: prepared.filter((r) => r.fx).length,
        ...(statement.kind === "deposit"
          ? { income: count("income"), transfers: count("transfer") }
          : {}),
      },
      chargesCents: prepared
        .filter((r) => r.kind === "charge" || r.kind === "fee")
        .reduce((s, r) => s + r.amountCents, 0),
      ...(statement.kind === "deposit"
        ? {
            incomeCents: -prepared
              .filter((r) => r.kind === "income")
              .reduce((s, r) => s + r.amountCents, 0),
          }
        : {}),
    });
    rows.push(prepared.map((r) => previewRow(r, dupes.has(r.dedupeKey))));
  }

  const pairing = countNewPairs(
    matchTransfers(
      [...existing.candidates, ...newCandidates],
      [...existing.cardStatements, ...newCardStatements],
    ),
    new Set(newCandidates.map((c) => c.id)),
  );
  const summary: ImportSummary = {
    bank: statement.bank,
    kind: statement.kind,
    pairing,
    parserVersion: statement.parserVersion,
    statementDate: statement.statementDate,
    dueDate: statement.dueDate,
    minimumPaymentCents: statement.minimumPaymentCents,
    statementTotalCents: statement.statementTotalCents,
    totalsMatch: statement.totalsMatch,
    // A statement total that couldn't be found is unverified, not a pass. Bank
    // statements have no grand total: each account's balances are the check.
    allReconciled:
      cards.every((c) => c.reconciled === true) &&
      (statement.kind === "deposit" || statement.totalsMatch === true),
    cards,
    categories: categoryCounts(freshRows),
    warnings: [...statement.warnings, ...(categorised?.warnings ?? [])],
  };
  return { stored: { statement: { ...statement, cards: storedCards } }, summary, rows };
}

/**
 * Expires every overdue pending import of the signed-in user (RLS-scoped):
 * proposals become "expired", encrypted previews are deleted. The daily cron
 * (/api/cron/daily) does the same for users who never come back.
 */
export async function expireOverdueImports(tx: Tx, userId: string): Promise<number> {
  const now = new Date();
  const overdue = await tx
    .update(proposedActions)
    .set({ status: "expired" })
    .where(and(eq(proposedActions.status, "pending"), lt(proposedActions.expiresAt, now)))
    .returning({ id: proposedActions.id });
  await tx
    .update(imports)
    .set({ status: "expired", previewEnc: null })
    .where(and(eq(imports.status, "previewed"), lt(imports.expiresAt, now)));
  for (const p of overdue) await audit(tx, userId, p.id, "system", "expired");
  return overdue.length;
}

/**
 * The daily cron sweep (api/cron/daily): the same expiry for every user,
 * including users who never come back. Runs as the owner role, outside RLS, and
 * touches only overdue pending proposals and their uncommitted previews.
 */
export async function expireOverdueForAllUsers(
  db: AppDb,
): Promise<{ proposals: number; previews: number }> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const overdue = await tx
      .update(proposedActions)
      .set({ status: "expired" })
      .where(and(eq(proposedActions.status, "pending"), lt(proposedActions.expiresAt, now)))
      .returning({ id: proposedActions.id, userId: proposedActions.userId });
    const cleared = await tx
      .update(imports)
      .set({ status: "expired", previewEnc: null })
      .where(and(eq(imports.status, "previewed"), lt(imports.expiresAt, now)))
      .returning({ id: imports.id });
    if (overdue.length) {
      await tx.insert(auditLog).values(
        overdue.map((p) => ({
          userId: p.userId,
          proposalId: p.id,
          actor: "system" as const,
          event: "expired" as const,
        })),
      );
    }
    return { proposals: overdue.length, previews: cleared.length };
  });
}

function decryptPreview(crypto: UserCrypto, previewEnc: string): StoredPreview {
  return JSON.parse(crypto.decrypt("imports.preview", previewEnc)) as StoredPreview;
}

function rowsFromStored(stored: StoredPreview, dupes: Set<string>): PreviewRow[][] {
  return stored.statement.cards.map((c) =>
    c.rows.map((r) => previewRow(r, dupes.has(r.dedupeKey))),
  );
}

/**
 * Step 1: parse the upload and create a pending `commit_import` proposal.
 * Re-uploading a file that is still awaiting approval returns the same preview.
 */
/**
 * The deterministic parsers first. A layout none of them reads goes to the AI
 * fallback extractor (PRD IMP-5) only when you asked for it (`ai`), within the
 * LLM budgets; its usage is recorded like any other model call.
 */
async function parseWithFallback(
  db: AppDb,
  userId: string,
  file: { bytes: Uint8Array; password?: string; ai?: boolean },
): Promise<ParseResult> {
  try {
    const parsed = await parseStatementFile(file.bytes, { password: file.password });
    await recordParseOutcome(db, {
      bank: parsed.statement.bank,
      method: "parser",
      outcome: reconcileOutcome(parsed.statement),
    });
    return parsed;
  } catch (e) {
    const code = e instanceof ParseError ? e.code : null;
    if (code !== "unsupported_format" || !file.ai) {
      if (code) await recordParseOutcome(db, { bank: "unknown", method: "parser", outcome: code });
      throw e;
    }
  }
  const llm = await getLlm();
  if (!llm || (await budgetBlock(db, userId, "extract"))) {
    await recordParseOutcome(db, { bank: "unknown", method: "ai", outcome: "ai_unavailable" });
    throw new ParseError("ai_unavailable");
  }
  const model = getEnv().MODEL_EXTRACT;
  try {
    const {
      result,
      usage: used,
      model: servedBy,
    } = await extractWithAi(llm, model, file.bytes, {
      password: file.password,
      signal: AbortSignal.timeout(55_000),
    });
    await withUser(db, userId, (tx) => recordUsage(tx, userId, "extract", servedBy, used));
    await recordParseOutcome(db, {
      bank: result.statement.bank,
      method: "ai",
      outcome: reconcileOutcome(result.statement),
    });
    logEvent("import.ai_extracted", {
      bank: result.statement.bank,
      rows: result.statement.cards.reduce((s, c) => s + c.rows.length, 0),
    });
    return result;
  } catch (e) {
    const code = e instanceof ParseError ? e.code : "ai_failed";
    await recordParseOutcome(db, { bank: "unknown", method: "ai", outcome: code });
    if (e instanceof ParseError || e instanceof PdfError) throw e;
    logError("import.ai_extract", e);
    throw new ParseError("ai_unavailable");
  }
}

export async function previewImport(
  db: AppDb,
  userId: string,
  keys: MasterKeys,
  file: { bytes: Uint8Array; password?: string; ai?: boolean },
): Promise<ImportPreview> {
  const fileSha256 = sha256(file.bytes);
  // Parse outside the transaction: CPU work, or one model call for the AI fallback.
  const parsed = await parseWithFallback(db, userId, file);
  // Categorise outside it too: the classifier is a network call. Skipped for a
  // file that already has a live preview or was committed.
  const categorised = await categoriseStatement(db, userId, fileSha256, parsed);

  return withUser(db, userId, async (tx) => {
    const crypto = await getUserCrypto(tx, userId, keys);
    await expireOverdueImports(tx, userId);
    const [existing] = await tx.select().from(imports).where(eq(imports.fileSha256, fileSha256));
    if (existing?.status === "committed") throw new ImportError("already_imported");
    if (existing?.status === "previewed") {
      const [proposal] = await tx
        .select()
        .from(proposedActions)
        .where(
          and(
            eq(proposedActions.type, "commit_import"),
            sql`${proposedActions.payload}->>'importId' = ${existing.id}`,
          ),
        );
      if (proposal && !(await expireIfDue(tx, userId, proposal)) && proposal.status === "pending") {
        return readPreview(tx, crypto, existing, proposal);
      }
    }
    if (existing) await tx.delete(imports).where(eq(imports.id, existing.id));

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [recent] = sqlRows<{ n: number }>(
      await tx.execute(
        sql`select count(*)::int as n from imports where created_at >= ${since.toISOString()}`,
      ),
    );
    if (recent!.n >= MAX_IMPORTS_PER_30_DAYS) throw new ImportError("rate_limited");

    const { stored, summary, rows } = await buildPreview(
      tx,
      crypto,
      parsed.statement,
      parsed.names,
      categorised,
      parsed.accountRefs,
    );
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
    const previewEnc = crypto.encrypt("imports.preview", JSON.stringify(stored));
    const [imp] = await tx
      .insert(imports)
      .values({
        userId,
        fileSha256,
        bank: summary.bank,
        parserVersion: summary.parserVersion,
        statementDate: summary.statementDate,
        status: "previewed",
        previewEnc,
        summary,
        expiresAt,
      })
      // Two identical uploads at once: the unique (user, file hash) index makes the
      // second insert wait for the first, then do nothing; it returns the winner's preview.
      .onConflictDoNothing()
      .returning();
    if (!imp) {
      const [winner] = await tx.select().from(imports).where(eq(imports.fileSha256, fileSha256));
      if (winner?.status === "committed") throw new ImportError("already_imported");
      const [winnerProposal] = winner
        ? await tx
            .select()
            .from(proposedActions)
            .where(
              and(
                eq(proposedActions.type, "commit_import"),
                sql`${proposedActions.payload}->>'importId' = ${winner.id}`,
              ),
            )
        : [];
      if (!winner || !winnerProposal) throw new ImportError("proposal_not_found");
      return readPreview(tx, crypto, winner, winnerProposal);
    }

    // The payload binds the approval to exactly this preview (ACT-6).
    const payload = { importId: imp!.id, previewSha256: sha256(previewEnc) };
    const [proposal] = await tx
      .insert(proposedActions)
      .values({
        userId,
        type: "commit_import",
        payload,
        payloadHash: sha256(canonical(payload)),
        preview: summary,
        proposer: "system",
        expiresAt,
      })
      .returning();
    await audit(tx, userId, proposal!.id, "system", "proposed", {
      type: "commit_import",
      bank: summary.bank,
    });

    logEvent("import.previewed", {
      bank: summary.bank,
      cards: summary.cards.length,
      rows: summary.cards.reduce((s, c) => s + c.counts.rows, 0),
      duplicates: summary.cards.reduce((s, c) => s + c.counts.duplicates, 0),
      reconciled: summary.allReconciled,
    });
    return {
      importId: imp!.id,
      proposalId: proposal!.id,
      status: "previewed",
      expiresAt: expiresAt.toISOString(),
      summary,
      rows,
    };
  });
}

async function readPreview(
  tx: Tx,
  crypto: UserCrypto,
  imp: typeof imports.$inferSelect,
  proposal: typeof proposedActions.$inferSelect,
): Promise<ImportPreview> {
  const summary = imp.summary as ImportSummary;
  let rows: PreviewRow[][] = [];
  if (imp.previewEnc) {
    const stored = decryptPreview(crypto, imp.previewEnc);
    const dupes = await existingDedupeKeys(
      tx,
      stored.statement.cards.flatMap((c) => c.rows.map((r) => r.dedupeKey)),
    );
    rows = rowsFromStored(stored, dupes);
  }
  return {
    importId: imp.id,
    proposalId: proposal.id,
    status: imp.status,
    expiresAt: imp.expiresAt?.toISOString() ?? null,
    summary,
    rows,
  };
}

/** Re-opens a preview (e.g. from Activity). Null if it isn't this user's. */
export async function getImportPreview(
  db: AppDb,
  userId: string,
  keys: MasterKeys,
  importId: string,
): Promise<ImportPreview | null> {
  return withUser(db, userId, async (tx) => {
    const [imp] = await tx.select().from(imports).where(eq(imports.id, importId));
    if (!imp) return null;
    const [proposal] = await tx
      .select()
      .from(proposedActions)
      .where(
        and(
          eq(proposedActions.type, "commit_import"),
          sql`${proposedActions.payload}->>'importId' = ${imp.id}`,
        ),
      );
    if (!proposal) return null;
    if (await expireIfDue(tx, userId, proposal)) {
      const [fresh] = await tx.select().from(imports).where(eq(imports.id, importId));
      return readPreview(tx, await getUserCrypto(tx, userId, keys), fresh!, {
        ...proposal,
        status: "expired",
      });
    }
    return readPreview(tx, await getUserCrypto(tx, userId, keys), imp, proposal);
  });
}

export type CommitResult = {
  inserted: number;
  duplicates: number;
  cards: number;
  allReconciled: boolean;
  /** Transfer legs paired across your accounts by this import (IMP-10). */
  paired: number;
};

/**
 * Step 2: the user approves. Executes exactly the previewed rows, once.
 * The proposal row is locked, so a double click can't commit twice.
 */
export async function approveProposal(
  db: AppDb,
  userId: string,
  keys: MasterKeys,
  proposalId: string,
): Promise<CommitResult> {
  // Expiry must be committed even though the approval fails, so it is reported
  // out of the transaction instead of thrown inside it (a throw would roll it back).
  const outcome = await withUser(db, userId, async (tx): Promise<CommitResult | "expired"> => {
    const [proposal] = await tx
      .select()
      .from(proposedActions)
      .where(eq(proposedActions.id, proposalId))
      .for("update");
    if (!proposal || proposal.type !== "commit_import") throw new ImportError("proposal_not_found");
    if (proposal.status !== "pending") throw new ImportError("proposal_not_pending");
    if (await expireIfDue(tx, userId, proposal)) return "expired";

    const payload = proposal.payload as { importId: string; previewSha256: string };
    const [imp] = await tx.select().from(imports).where(eq(imports.id, payload.importId));
    if (
      sha256(canonical(payload)) !== proposal.payloadHash ||
      !imp?.previewEnc ||
      imp.status !== "previewed" ||
      sha256(imp.previewEnc) !== payload.previewSha256
    ) {
      throw new ImportError("preview_tampered");
    }
    await audit(tx, userId, proposal.id, "user", "approved");

    const crypto = await getUserCrypto(tx, userId, keys);
    const { statement } = decryptPreview(crypto, imp.previewEnc);
    const categoryIds = await ensureDefaultCategories(tx, userId);
    const result: CommitResult = {
      inserted: 0,
      duplicates: 0,
      cards: statement.cards.length,
      allReconciled: true,
      paired: 0,
    };
    for (const card of statement.cards) {
      const accountId = await upsertAccount(tx, userId, {
        bank: statement.bank,
        productName: card.productName,
        ordinal: card.ordinal,
        identityKey: card.identityKey ?? null,
        // Previews stored before Phase 2b have no kind: they are card statements.
        kind: statement.kind ?? "card",
      });
      const r = await insertPreparedStatement(
        tx,
        crypto,
        {
          bank: statement.bank,
          productName: card.productName,
          ordinal: card.ordinal,
          accountId,
          importId: imp.id,
          statementDate: statement.statementDate,
          dueDate: statement.dueDate,
          minimumPaymentCents: statement.minimumPaymentCents,
          previousBalanceCents: card.previousBalanceCents,
          totalCents: card.totalCents,
          rows: card.rows,
        },
        categoryIds,
      );
      result.inserted += r.inserted;
      result.duplicates += r.duplicates;
      result.allReconciled &&= r.reconciled === true;
    }

    // Pair this statement's transfers and card payments with your other accounts.
    result.paired = (await pairTransfers(tx)).pairs;

    const now = new Date();
    // The preview has served its purpose: committed rows live in the ledger now.
    await tx
      .update(imports)
      .set({ status: "committed", previewEnc: null })
      .where(eq(imports.id, imp.id));
    await tx
      .update(proposedActions)
      .set({ status: "executed", decidedAt: now, executedAt: now })
      .where(eq(proposedActions.id, proposal.id));
    await audit(tx, userId, proposal.id, "system", "executed", { ...result }, { importId: imp.id });
    logEvent("import.committed", { ...result });
    return result;
  });
  if (outcome === "expired") throw new ImportError("proposal_expired");
  return outcome;
}

/** The user rejects (discards) a pending import. */
export async function rejectProposal(db: AppDb, userId: string, proposalId: string): Promise<void> {
  await withUser(db, userId, async (tx) => {
    const [proposal] = await tx
      .select()
      .from(proposedActions)
      .where(eq(proposedActions.id, proposalId))
      .for("update");
    if (!proposal || proposal.type !== "commit_import") throw new ImportError("proposal_not_found");
    if (proposal.status !== "pending") throw new ImportError("proposal_not_pending");
    await tx
      .update(proposedActions)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(eq(proposedActions.id, proposal.id));
    const importId = (proposal.payload as { importId: string }).importId;
    await tx
      .update(imports)
      .set({ status: "discarded", previewEnc: null })
      .where(eq(imports.id, importId));
    await audit(tx, userId, proposal.id, "user", "rejected");
    logEvent("import.discarded", {});
  });
}

export type PendingProposal =
  | {
      id: string;
      type: "commit_import";
      importId: string | null;
      summary: ImportSummary;
      createdAt: string;
      expiresAt: string;
    }
  | {
      id: string;
      type: Exclude<ActionType, "commit_import">;
      proposer: Proposer;
      preview: ActionPreview;
      createdAt: string;
      expiresAt: string;
    };

export async function listPendingProposals(db: AppDb, userId: string): Promise<PendingProposal[]> {
  return withUser(db, userId, async (tx) => {
    await expireOverdueImports(tx, userId);
    const rows = await tx
      .select()
      .from(proposedActions)
      .where(and(eq(proposedActions.status, "pending"), gte(proposedActions.expiresAt, new Date())))
      .orderBy(proposedActions.createdAt);
    return rows.flatMap((p): PendingProposal[] => {
      const times = { createdAt: p.createdAt.toISOString(), expiresAt: p.expiresAt.toISOString() };
      if (p.type === "commit_import") {
        return [
          {
            id: p.id,
            type: "commit_import",
            importId: (p.payload as { importId?: string }).importId ?? null,
            summary: p.preview as ImportSummary,
            ...times,
          },
        ];
      }
      return [
        {
          id: p.id,
          type: p.type,
          proposer: p.proposer,
          preview: p.preview as ActionPreview,
          ...times,
        },
      ];
    });
  });
}

export type ActivityEvent = {
  id: string;
  event: string;
  actor: string;
  proposalId: string | null;
  createdAt: string;
  /** What the event was about, built from the proposal's own preview (no model text). */
  subject: string | null;
};

function proposalSubject(type: string | null, preview: unknown): string | null {
  if (type === "commit_import") {
    const p = preview as Partial<ImportSummary> | null;
    return p?.bank && p.statementDate
      ? `Import ${p.bank} ${p.kind === "deposit" ? "account " : ""}statement ${longDate(p.statementDate)}`
      : "Import";
  }
  // Every other action carries a server-built title (ACT-4).
  return (preview as Partial<ActionPreview> | null)?.title ?? null;
}

export async function listRecentActivity(
  db: AppDb,
  userId: string,
  limit = 20,
): Promise<ActivityEvent[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx
      .select({
        id: auditLog.id,
        event: auditLog.event,
        actor: auditLog.actor,
        proposalId: auditLog.proposalId,
        createdAt: auditLog.createdAt,
        type: proposedActions.type,
        preview: proposedActions.preview,
      })
      .from(auditLog)
      .leftJoin(proposedActions, eq(proposedActions.id, auditLog.proposalId))
      .orderBy(sql`${auditLog.createdAt} desc`)
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      actor: r.actor,
      proposalId: r.proposalId,
      createdAt: r.createdAt.toISOString(),
      subject: proposalSubject(r.type, r.preview),
    }));
  });
}
