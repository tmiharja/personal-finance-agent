import { getDb } from "@/db/client";
import { approveAny, rejectAny } from "@/server/actions";
import { ProposalError } from "@/server/actions/common";
import { isSameOrigin, jsonError, masterKeys, sessionUserId } from "@/server/http";
import { ImportError } from "@/server/import/service";
import { logError } from "@/server/log";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Record<string, number> = {
  proposal_not_found: 404,
  proposal_expired: 410,
  proposal_not_pending: 409,
  proposal_stale: 409,
  preview_tampered: 409,
  already_imported: 409,
};

/** Approve or reject a proposal. Only the signed-in owner can (RLS), only once. */
export async function decide(
  request: Request,
  id: string,
  decision: "approve" | "reject",
): Promise<Response> {
  if (!isSameOrigin(request)) return jsonError("bad_origin", 403);
  const userId = await sessionUserId(request);
  if (!userId) return jsonError("unauthenticated", 401);
  if (!UUID.test(id)) return jsonError("proposal_not_found", 404);
  try {
    if (decision === "approve") {
      return Response.json(await approveAny(getDb(), userId, masterKeys(), id));
    }
    await rejectAny(getDb(), userId, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof ImportError || e instanceof ProposalError) {
      return jsonError(e.code, STATUS[e.code] ?? 409);
    }
    logError(`proposal.${decision}`, e);
    return jsonError("internal_error", 500);
  }
}
