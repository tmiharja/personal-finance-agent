import { eq } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { proposedActions } from "@/db/schema";
import { withUser } from "@/db/with-user";
import type { MasterKeys } from "@/server/crypto/envelope";
import {
  approveProposal as approveImport,
  rejectProposal as rejectImport,
} from "@/server/import/service";
import { runDetectors } from "@/server/detect/run";
import { logError } from "@/server/log";
import { ProposalError } from "./common";
import "./defs";
import * as engine from "./engine";

export {
  applyDirect,
  definition,
  ACTION_STATES,
  listActionHistory,
  propose,
  proposeIn,
  STEP_UP_ROWS,
  UNDO_WINDOW_MS,
  type Decider,
  type ActionHistoryItem,
  type ActionState,
  type HistoryFilter,
  type ActionPreview,
  type ActionType,
  type Proposer,
} from "./engine";

/** Routes a decision to the executor for the proposal's type (ACT-1 allowlist). */
async function typeOf(db: AppDb, userId: string, id: string) {
  const [p] = await withUser(db, userId, (tx) =>
    tx
      .select({ type: proposedActions.type })
      .from(proposedActions)
      .where(eq(proposedActions.id, id)),
  );
  if (!p) throw new ProposalError("proposal_not_found");
  return p.type;
}

/**
 * DET-9: the ledger changed, so re-run the detectors. Best effort: a detector
 * failure is logged and never undoes the change.
 */
export async function afterLedgerChange(db: AppDb, userId: string, keys: MasterKeys) {
  await runDetectors(db, userId, keys).catch((e) => logError("detect.after_change", e));
}

export async function approveAny(
  db: AppDb,
  userId: string,
  keys: MasterKeys,
  id: string,
  decider: engine.Decider,
) {
  const type = await typeOf(db, userId, id);
  if (type === "commit_import") {
    const result = await approveImport(db, userId, keys, id);
    await afterLedgerChange(db, userId, keys);
    return result;
  }
  const { result, ledger } = await engine.approve(db, userId, id, decider);
  if (ledger) await afterLedgerChange(db, userId, keys);
  return result;
}

export async function rejectAny(db: AppDb, userId: string, id: string): Promise<void> {
  const type = await typeOf(db, userId, id);
  if (type === "commit_import") return rejectImport(db, userId, id);
  return engine.reject(db, userId, id);
}

/** Batch approval (ACT-5): each proposal on its own; detectors run once at the end. */
export async function approveMany(
  db: AppDb,
  userId: string,
  keys: MasterKeys,
  ids: readonly string[],
  decider: engine.Decider,
) {
  const results = await engine.approveMany(db, userId, ids, decider);
  if (results.some((r) => r.ok && r.ledger)) await afterLedgerChange(db, userId, keys);
  return results.map(({ id, ok, code }) => (ok ? { id, ok } : { id, ok, code }));
}

export async function undoAction(db: AppDb, userId: string, keys: MasterKeys, id: string) {
  const { ledger } = await engine.undo(db, userId, id);
  if (ledger) await afterLedgerChange(db, userId, keys);
}

/** Your own edit, applied now and audited (and undoable from Activity). */
export async function applyNow(
  db: AppDb,
  userId: string,
  keys: MasterKeys,
  type: engine.ActionType,
  input: unknown,
  decider: engine.Decider,
) {
  const done = await engine.applyDirect(db, userId, type, input, decider);
  if (done.ledger) await afterLedgerChange(db, userId, keys);
  return { proposalId: done.proposalId, result: done.result };
}
