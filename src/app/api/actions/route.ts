import { z } from "zod";
import { getDb } from "@/db/client";
import { applyNow, definition, type ActionType } from "@/server/actions";
import { isSameOrigin, jsonError, masterKeys, sessionUserId } from "@/server/http";
import { actionError } from "@/server/proposal-route";

const body = z.object({ type: z.string().max(40), input: z.unknown() });

/**
 * Your own edit from a screen (Settings, Bills): validated, applied and
 * audited through the action engine, and undoable from Activity. Only
 * registered types; exports have their own route.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return jsonError("bad_origin", 403);
  const userId = await sessionUserId(request);
  if (!userId) return jsonError("unauthenticated", 401);
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("bad_request", 400);
  const type = parsed.data.type as ActionType;
  if (!definition(type) || type === "export_csv") return jsonError("action_not_allowed", 400);
  try {
    return Response.json(await applyNow(getDb(), userId, masterKeys(), type, parsed.data.input));
  } catch (e) {
    return actionError(e, "actions.apply");
  }
}
