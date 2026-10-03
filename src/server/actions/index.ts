import { eq } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { proposedActions } from "@/db/schema";
import { withUser } from "@/db/with-user";
import type { MasterKeys } from "@/server/crypto/envelope";
import {
  approveProposal as approveImport,
  rejectProposal as rejectImport,
} from "@/server/import/service";
import { ProposalError } from "./common";
import { approveRuleProposal, rejectSimpleProposal } from "./rules";

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

export async function approveAny(db: AppDb, userId: string, keys: MasterKeys, id: string) {
  const type = await typeOf(db, userId, id);
  if (type === "commit_import") return approveImport(db, userId, keys, id);
  if (type === "create_rule") return approveRuleProposal(db, userId, id);
  throw new ProposalError("proposal_not_found");
}

export async function rejectAny(db: AppDb, userId: string, id: string): Promise<void> {
  const type = await typeOf(db, userId, id);
  if (type === "commit_import") return rejectImport(db, userId, id);
  return rejectSimpleProposal(db, userId, id);
}
