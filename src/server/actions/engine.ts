import { and, desc, eq, ne, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import type { AppDb } from "@/db/client";
import { auditLog, proposedActions } from "@/db/schema";
import { withUser, type Tx } from "@/db/with-user";
import { logEvent } from "@/server/log";
import { scanForPii } from "@/server/pii/firewall";
import {
  audit,
  canonical,
  expireIfDue,
  lockProposal,
  PROPOSAL_TTL_MS,
  ProposalError,
  sha256,
  type Proposal,
} from "./common";

/**
 * The action engine (PRD §5.6, ACT-1…ACT-10). Every change to your data that
 * isn't an import goes through here, whoever starts it:
 *
 *   propose  → validate (ACT-7) → server-built preview + the versions of every
 *              row it touches (ACT-4, ACT-6) → a pending proposal, audited
 *   approve  → lock → re-check payload hash and versions (stale if anything
 *              changed) → execute once → store the inverse (ACT-8, ACT-9)
 *   undo     → within 30 days, if nothing it touched has changed since
 *
 * The agent can only propose: nothing it does executes without your approval
 * (ACT-10). Your own direct edits ("this transaction only", dismiss an alert)
 * are proposed and approved in one step, so they are audited and undoable too.
 */

export type ActionType = (typeof proposedActions.$inferInsert)["type"];
export type Proposer = "agent" | "user" | "detector" | "system";

/** Deterministic, server-built preview: fixed templates over data, never model text (ACT-4). */
export type ActionPreview = {
  title: string;
  lines: string[];
  changes?: { from: string; to: string; count: number }[];
  sample?: { txnDate: string; merchant: string; amountCents: number }[];
  /** How many rows or items the action touches. */
  affected: number;
  notes?: string[];
};

/** "txn:<id>" → version, "alert:<id>" → status…: whatever must not change under a proposal. */
export type Versions = Record<string, string | number>;

export type ActionDef<I = unknown, P = unknown> = {
  type: ActionType;
  /** What a caller (you, the app or the agent) may ask for. */
  input: z.ZodType<I>;
  /** What approval executes: re-validated on approval. */
  payload: z.ZodType<P>;
  undoable: boolean;
  /** Re-run the detectors after it executes (it changed transactions or rules). */
  ledger: boolean;
  /** Only as your own direct action, never a pending proposal (an export needs you there for the file). */
  directOnly?: boolean;
  /** Zero rows is still a valid request (an export of an empty filter). */
  allowEmpty?: boolean;
  /** Validates against your data (RLS: anything not yours doesn't exist) and builds the preview. */
  prepare(tx: Tx, userId: string, input: I): Promise<{ payload: P; preview: ActionPreview }>;
  /** Current versions of everything the payload touches; `lock` locks the rows (FOR UPDATE). */
  versions(tx: Tx, payload: P, lock: boolean): Promise<Versions>;
  execute(
    tx: Tx,
    userId: string,
    payload: P,
    proposalId: string,
  ): Promise<{ result: Record<string, unknown>; inverse: unknown }>;
  undo?(tx: Tx, userId: string, payload: P, inverse: unknown): Promise<void>;
};

const REGISTRY = new Map<ActionType, ActionDef>();

export function register<I, P>(def: ActionDef<I, P>): ActionDef<I, P> {
  REGISTRY.set(def.type, def as unknown as ActionDef);
  return def;
}

export const definition = (type: ActionType) => REGISTRY.get(type);

export const UNDO_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** AUTH-3: approving a change to more than this many rows needs a recent sign-in. */
export const STEP_UP_ROWS = 100;

/** Who is deciding: `fresh` when the sign-in is recent enough for a large change (AUTH-3). */
export type Decider = { fresh: boolean };

const sameVersions = (a: Versions, b: Versions) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

async function proposeTx(
  tx: Tx,
  userId: string,
  proposer: Proposer,
  type: ActionType,
  rawInput: unknown,
  direct = false,
): Promise<{ proposal: Proposal; preview: ActionPreview }> {
  const def = REGISTRY.get(type);
  if (!def) throw new ProposalError("action_not_allowed"); // ACT-1: not on the allowlist
  if (def.directOnly && !direct) throw new ProposalError("action_not_allowed");
  const input = def.input.safeParse(rawInput);
  if (!input.success) throw new ProposalError("invalid_input");
  const { payload, preview } = await def.prepare(tx, userId, input.data);
  if (preview.affected === 0 && !def.allowEmpty) throw new ProposalError("nothing_to_change");
  // The PII firewall, before anything is stored: a tag, a payee or a preview
  // must never carry a card number, NRIC, phone number or email.
  if (textOf({ payload, preview }).some((t) => scanForPii(t).length))
    throw new ProposalError("contains_personal_data");
  const baseVersions = await def.versions(tx, payload, false);
  const [proposal] = await tx
    .insert(proposedActions)
    .values({
      userId,
      type,
      payload: payload as object,
      payloadHash: sha256(canonical(payload)),
      preview,
      baseVersions,
      proposer,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    })
    .returning();
  await audit(tx, userId, proposal!.id, proposer, "proposed", {
    type,
    affected: preview.affected,
  });
  return { proposal: proposal!, preview };
}

const ID_OR_DATE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2})$/i;

/** Every free-text string in a value (ids and dates aren't text). */
function textOf(value: unknown): string[] {
  if (typeof value === "string") return ID_OR_DATE.test(value) ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(textOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(textOf);
  return [];
}

type Decided = { result: Record<string, unknown>; type: ActionType; ledger: boolean };

/** Executes a locked, pending proposal exactly as previewed, or marks it stale. */
async function executeTx(
  tx: Tx,
  userId: string,
  proposal: Proposal,
  decider: Decider,
): Promise<Decided | "expired" | "stale"> {
  const def = REGISTRY.get(proposal.type);
  if (!def) throw new ProposalError("proposal_not_found");
  if (proposal.status !== "pending") throw new ProposalError("proposal_not_pending");
  if (await expireIfDue(tx, userId, proposal)) return "expired";
  const affected = (proposal.preview as Partial<ActionPreview>).affected ?? 0;
  if (affected > STEP_UP_ROWS && !decider.fresh) throw new ProposalError("reauth_required");
  const payload = def.payload.safeParse(proposal.payload);
  if (!payload.success || sha256(canonical(proposal.payload)) !== proposal.payloadHash) {
    throw new ProposalError("proposal_not_found");
  }
  // ACT-6: every row exactly as previewed. Locked first, so a concurrent change
  // either commits before this check (stale) or waits for this approval.
  const now = await def.versions(tx, payload.data, true);
  if (!sameVersions(proposal.baseVersions as Versions, now)) {
    await tx
      .update(proposedActions)
      .set({ status: "stale", decidedAt: new Date(), errorCode: "proposal_stale" })
      .where(eq(proposedActions.id, proposal.id));
    await audit(tx, userId, proposal.id, "system", "failed", { code: "proposal_stale" });
    return "stale";
  }
  await audit(tx, userId, proposal.id, "user", "approved");
  const { result, inverse } = await def.execute(tx, userId, payload.data, proposal.id);
  const at = new Date();
  await tx
    .update(proposedActions)
    .set({ status: "executed", decidedAt: at, executedAt: at })
    .where(eq(proposedActions.id, proposal.id));
  // Recorded once this proposal counts as executed: versions can include the
  // latest decision on a target (see lastDecision), so a later change that
  // restores the same value still blocks this undo.
  const after = await def.versions(tx, payload.data, false);
  // The inverse is ids and previous values only, never descriptors (ACT-8).
  await audit(tx, userId, proposal.id, "system", "executed", result, {
    undo: def.undoable ? inverse : null,
    after,
  });
  logEvent("action.executed", { type: proposal.type, ...countsOnly(result) });
  return { result, type: proposal.type, ledger: def.ledger };
}

/** Logs carry counts only. */
const countsOnly = (r: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(r).filter(([, v]) => typeof v === "number"));

function settle<T>(outcome: T | "expired" | "stale"): T {
  if (outcome === "expired") throw new ProposalError("proposal_expired");
  if (outcome === "stale") throw new ProposalError("proposal_stale");
  return outcome;
}

/** Creates a pending proposal. Nothing changes until it's approved. */
export async function propose(
  db: AppDb,
  userId: string,
  proposer: Proposer,
  type: ActionType,
  input: unknown,
): Promise<{ proposalId: string; preview: ActionPreview; expiresAt: string }> {
  return withUser(db, userId, async (tx) => {
    const { proposal, preview } = await proposeTx(tx, userId, proposer, type, input);
    return { proposalId: proposal.id, preview, expiresAt: proposal.expiresAt.toISOString() };
  });
}

/** In an open transaction (the Ask tools run inside one). */
export async function proposeIn(
  tx: Tx,
  userId: string,
  proposer: Proposer,
  type: ActionType,
  input: unknown,
) {
  const { proposal, preview } = await proposeTx(tx, userId, proposer, type, input);
  return { proposalId: proposal.id, preview, expiresAt: proposal.expiresAt.toISOString() };
}

/** Approves one pending proposal (any type but imports). */
export async function approve(
  db: AppDb,
  userId: string,
  proposalId: string,
  decider: Decider = { fresh: false },
): Promise<Decided> {
  // Expiry and staleness are committed, then reported (a throw would roll them back).
  const outcome = await withUser(db, userId, async (tx) => {
    const proposal = await lockProposal(tx, proposalId);
    if (!proposal || proposal.type === "commit_import")
      throw new ProposalError("proposal_not_found");
    return executeTx(tx, userId, proposal, decider);
  });
  return settle(outcome);
}

/**
 * Your own direct edit: proposed and approved in one step, so it is validated,
 * audited and undoable like any other change.
 */
export async function applyDirect(
  db: AppDb,
  userId: string,
  type: ActionType,
  input: unknown,
  decider: Decider = { fresh: false },
): Promise<Decided & { proposalId: string }> {
  const outcome = await withUser(db, userId, async (tx) => {
    const { proposal } = await proposeTx(tx, userId, "user", type, input, true);
    const done = await executeTx(tx, userId, proposal, decider);
    return typeof done === "string" ? done : { ...done, proposalId: proposal.id };
  });
  return settle(outcome);
}

export async function reject(db: AppDb, userId: string, proposalId: string): Promise<void> {
  await withUser(db, userId, async (tx) => {
    const proposal = await lockProposal(tx, proposalId);
    if (!proposal || proposal.type === "commit_import")
      throw new ProposalError("proposal_not_found");
    if (proposal.status !== "pending") throw new ProposalError("proposal_not_pending");
    await tx
      .update(proposedActions)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(and(eq(proposedActions.id, proposal.id), ne(proposedActions.status, "executed")));
    await audit(tx, userId, proposal.id, "user", "rejected");
  });
}

/**
 * ACT-9: undoes an executed change within 30 days, if nothing it touched has
 * changed since (otherwise undoing would overwrite a newer decision).
 */
export async function undo(
  db: AppDb,
  userId: string,
  proposalId: string,
): Promise<{ type: ActionType; ledger: boolean }> {
  return withUser(db, userId, async (tx) => {
    const proposal = await lockProposal(tx, proposalId);
    if (!proposal) throw new ProposalError("proposal_not_found");
    const def = REGISTRY.get(proposal.type);
    if (!def?.undoable || !def.undo) throw new ProposalError("not_undoable");
    if (proposal.status !== "executed") throw new ProposalError("not_undoable");
    if (proposal.undoneAt) throw new ProposalError("already_undone");
    if (!proposal.executedAt || Date.now() - proposal.executedAt.getTime() > UNDO_WINDOW_MS)
      throw new ProposalError("undo_expired");
    const [executed] = await tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.proposalId, proposal.id), eq(auditLog.event, "executed")));
    const stored = executed?.inverse as { undo: unknown; after: Versions } | null;
    if (!stored?.undo) throw new ProposalError("not_undoable");
    const payload = def.payload.parse(proposal.payload);
    const now = await def.versions(tx, payload, true);
    if (!sameVersions(stored.after, now)) throw new ProposalError("undo_stale");
    await def.undo(tx, userId, payload, stored.undo);
    await tx
      .update(proposedActions)
      .set({ undoneAt: new Date() })
      .where(eq(proposedActions.id, proposal.id));
    await audit(tx, userId, proposal.id, "user", "undone", { type: proposal.type });
    logEvent("action.undone", { type: proposal.type });
    return { type: proposal.type, ledger: def.ledger };
  });
}

/** Approves several proposals, each on its own (ACT-5): one failing doesn't block the rest. */
export async function approveMany(
  db: AppDb,
  userId: string,
  ids: readonly string[],
  decider: Decider = { fresh: false },
): Promise<{ id: string; ok: boolean; code?: string; ledger?: boolean }[]> {
  const out = [];
  for (const id of ids) {
    try {
      const r = await approve(db, userId, id, decider);
      out.push({ id, ok: true, ledger: r.ledger });
    } catch (e) {
      out.push({ id, ok: false, code: e instanceof ProposalError ? e.code : "internal_error" });
    }
  }
  return out;
}

/** What happened to a decided proposal, as Activity shows it. */
export type ActionState = "done" | "undone" | "discarded" | "expired" | "failed";
export const ACTION_STATES: readonly ActionState[] = [
  "done",
  "undone",
  "discarded",
  "expired",
  "failed",
];

export type ActionHistoryItem = {
  id: string;
  type: ActionType;
  proposer: Proposer;
  state: ActionState;
  title: string;
  /** When it was decided (or expired). */
  at: string;
  undoneAt: string | null;
  canUndo: boolean;
};

const stateOf = (p: Proposal): ActionState =>
  p.undoneAt
    ? "undone"
    : p.status === "executed"
      ? "done"
      : p.status === "rejected"
        ? "discarded"
        : p.status === "expired"
          ? "expired"
          : "failed";

const STATE_WHERE: Record<ActionState, SQL> = {
  done: sql`${proposedActions.status} = 'executed' and ${proposedActions.undoneAt} is null`,
  undone: sql`${proposedActions.undoneAt} is not null`,
  discarded: sql`${proposedActions.status} = 'rejected'`,
  expired: sql`${proposedActions.status} = 'expired'`,
  failed: sql`${proposedActions.status} in ('stale', 'failed', 'approved')`,
};

export type HistoryFilter = { proposer?: Proposer; type?: ActionType; state?: ActionState };

/** Decided proposals, newest first, for Activity (ACT-8), optionally filtered. */
export async function listActionHistory(
  db: AppDb,
  userId: string,
  filter: HistoryFilter = {},
  limit = 50,
): Promise<ActionHistoryItem[]> {
  return withUser(db, userId, async (tx) => {
    const where = [ne(proposedActions.status, "pending")];
    if (filter.proposer) where.push(eq(proposedActions.proposer, filter.proposer));
    if (filter.type) where.push(eq(proposedActions.type, filter.type));
    if (filter.state) where.push(STATE_WHERE[filter.state]);
    const rows = await tx
      .select()
      .from(proposedActions)
      .where(and(...where))
      .orderBy(desc(proposedActions.createdAt))
      .limit(limit);
    return rows.map((p) => {
      const def = REGISTRY.get(p.type);
      const preview = p.preview as Partial<ActionPreview> & {
        bank?: string;
        statementDate?: string;
        kind?: string;
      };
      return {
        id: p.id,
        type: p.type,
        proposer: p.proposer,
        state: stateOf(p),
        title:
          preview.title ??
          (p.type === "commit_import" && preview.bank
            ? `Import ${preview.bank} ${preview.kind === "deposit" ? "account " : ""}statement${preview.statementDate ? ` (${preview.statementDate})` : ""}`
            : p.type.replaceAll("_", " ")),
        at: (p.undoneAt ?? p.decidedAt ?? p.expiresAt).toISOString(),
        undoneAt: p.undoneAt?.toISOString() ?? null,
        canUndo:
          Boolean(def?.undoable) &&
          p.status === "executed" &&
          !p.undoneAt &&
          !!p.executedAt &&
          Date.now() - p.executedAt.getTime() <= UNDO_WINDOW_MS,
      };
    });
  });
}
