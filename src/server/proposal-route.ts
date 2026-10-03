import { getDb } from "@/db/client";
import { isSameOrigin, jsonError, masterKeys, sessionUserId } from "@/server/http";
import { approveProposal, ImportError, rejectProposal } from "@/server/import/service";
import { logError } from "@/server/log";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (decision === "approve")
      return Response.json(await approveProposal(getDb(), userId, masterKeys(), id));
    await rejectProposal(getDb(), userId, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof ImportError) {
      const status =
        e.code === "proposal_not_found" ? 404 : e.code === "proposal_expired" ? 410 : 409;
      return jsonError(e.code, status);
    }
    logError(`proposal.${decision}`, e);
    return jsonError("internal_error", 500);
  }
}
