import { z } from "zod";
import { getDb } from "@/db/client";
import { applyNow } from "@/server/actions";
import { isSameOrigin, jsonError, masterKeys, sessionUserId } from "@/server/http";
import { actionError } from "@/server/proposal-route";

const body = z.object({ ignored: z.boolean() });

/** Ignore a detected subscription (or show it again): applied now, audited, undoable. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return jsonError("bad_origin", 403);
  const userId = await sessionUserId(request);
  if (!userId) return jsonError("unauthenticated", 401);
  const { id } = await params;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !z.uuid().safeParse(id).success) return jsonError("bad_request", 400);
  try {
    return Response.json(
      await applyNow(getDb(), userId, masterKeys(), "set_subscription_status", {
        subscriptionId: id,
        ignored: parsed.data.ignored,
      }),
    );
  } catch (e) {
    return actionError(e, "subscriptions.patch");
  }
}
