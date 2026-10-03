import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { auditLog, imports, proposedActions } from "@/db/schema";
import type { Tx } from "@/db/with-user";

export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
/** ACT-7: the most rows one action may touch. */
export const MAX_ROWS_PER_ACTION = 2000;

export type ProposalErrorCode =
  | "proposal_not_found"
  | "proposal_not_pending"
  | "proposal_expired"
  | "proposal_stale"
  | "invalid_category"
  | "not_categorisable"
  | "too_many_rows"
  | "nothing_to_change"
  | "action_not_allowed"
  | "invalid_input"
  | "invalid_reference"
  | "not_undoable"
  | "undo_expired"
  | "undo_stale"
  | "already_undone";

export class ProposalError extends Error {
  constructor(readonly code: ProposalErrorCode) {
    super(`Proposal error: ${code}`);
    this.name = "ProposalError";
  }
}

export const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** JSON with sorted object keys, so a payload always hashes the same. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export type AuditEvent =
  "proposed" | "approved" | "rejected" | "executed" | "expired" | "failed" | "undone";

export async function audit(
  tx: Tx,
  userId: string,
  proposalId: string,
  actor: "agent" | "detector" | "user" | "system",
  event: AuditEvent,
  detail: Record<string, unknown> = {},
  inverse: Record<string, unknown> | null = null,
) {
  await tx.insert(auditLog).values({ userId, proposalId, actor, event, detail, inverse });
}

export type Proposal = typeof proposedActions.$inferSelect;

/** Expires a pending proposal (and an import's preview) once its 24 hours are up. */
export async function expireIfDue(tx: Tx, userId: string, proposal: Proposal): Promise<boolean> {
  if (proposal.status !== "pending" || proposal.expiresAt.getTime() > Date.now()) return false;
  await tx
    .update(proposedActions)
    .set({ status: "expired" })
    .where(eq(proposedActions.id, proposal.id));
  const importId = (proposal.payload as { importId?: string }).importId;
  if (importId) {
    await tx
      .update(imports)
      .set({ status: "expired", previewEnc: null })
      .where(eq(imports.id, importId));
  }
  await audit(tx, userId, proposal.id, "system", "expired");
  return true;
}

/** Locks a proposal row for a decision. */
export async function lockProposal(tx: Tx, id: string): Promise<Proposal | undefined> {
  const [p] = await tx
    .select()
    .from(proposedActions)
    .where(eq(proposedActions.id, id))
    .for("update");
  return p;
}
