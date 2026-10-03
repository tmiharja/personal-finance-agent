import { getDb } from "@/db/client";
import { approveAny, approveMany, rejectAny, undoAction } from "@/server/actions";
import { ProposalError } from "@/server/actions/common";
import { deciderOf, isSameOrigin, jsonError, masterKeys, sessionUser } from "@/server/http";
import { ImportError } from "@/server/import/service";
import { logError } from "@/server/log";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Record<string, number> = {
  proposal_not_found: 404,
  invalid_reference: 404,
  proposal_expired: 410,
  undo_expired: 410,
  proposal_not_pending: 409,
  proposal_stale: 409,
  reauth_required: 403,
  undo_stale: 409,
  already_undone: 409,
  not_undoable: 409,
  preview_tampered: 409,
  already_imported: 409,
  action_not_allowed: 400,
  invalid_input: 400,
  contains_personal_data: 400,
  invalid_category: 400,
  not_categorisable: 400,
  too_many_rows: 400,
  nothing_to_change: 400,
};

/** Maps an action or import error to its code; anything else is logged and hidden. */
export function actionError(e: unknown, where: string): Response {
  if (e instanceof ImportError || e instanceof ProposalError) {
    return jsonError(e.code, STATUS[e.code] ?? 409);
  }
  logError(where, e);
  return jsonError("internal_error", 500);
}

/** Approve, reject or undo a proposal. Only the signed-in owner can (RLS), only once. */
export async function decide(
  request: Request,
  id: string,
  decision: "approve" | "reject" | "undo",
): Promise<Response> {
  if (!isSameOrigin(request)) return jsonError("bad_origin", 403);
  const user = await sessionUser(request);
  if (!user) return jsonError("unauthenticated", 401);
  const userId = user.id;
  if (!UUID.test(id)) return jsonError("proposal_not_found", 404);
  try {
    if (decision === "approve") {
      return Response.json(await approveAny(getDb(), userId, masterKeys(), id, deciderOf(user)));
    }
    if (decision === "undo") await undoAction(getDb(), userId, masterKeys(), id);
    else await rejectAny(getDb(), userId, id);
    return Response.json({ ok: true });
  } catch (e) {
    return actionError(e, `proposal.${decision}`);
  }
}

/** ACT-5: approve several at once; each succeeds or fails on its own. */
export async function decideMany(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return jsonError("bad_origin", 403);
  const user = await sessionUser(request);
  if (!user) return jsonError("unauthenticated", 401);
  const userId = user.id;
  const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? body.ids : null;
  if (
    !ids ||
    !ids.length ||
    ids.length > 50 ||
    !ids.every((x) => typeof x === "string" && UUID.test(x))
  )
    return jsonError("bad_request", 400);
  try {
    const results = await approveMany(
      getDb(),
      userId,
      masterKeys(),
      [...new Set(ids as string[])],
      deciderOf(user),
    );
    return Response.json({ results });
  } catch (e) {
    return actionError(e, "proposal.approve_many");
  }
}
