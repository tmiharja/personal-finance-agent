import { z } from "zod";
import { getDb } from "@/db/client";
import { applyNow } from "@/server/actions";
import { reopenAlert } from "@/server/actions/reopen";
import { deciderOf, isSameOrigin, jsonError, masterKeys, sessionUser } from "@/server/http";
import { actionError } from "@/server/proposal-route";

const body = z.object({ status: z.enum(["open", "dismissed", "expected"]) });

/** Dismiss an alert, mark it expected (audited, undoable), or reopen it (undoes that). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return jsonError("bad_origin", 403);
  const user = await sessionUser(request);
  if (!user) return jsonError("unauthenticated", 401);
  const userId = user.id;
  const { id } = await params;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !z.uuid().safeParse(id).success) return jsonError("bad_request", 400);
  try {
    const { status } = parsed.data;
    if (status === "open") {
      await reopenAlert(getDb(), userId, masterKeys(), id);
      return Response.json({ ok: true });
    }
    const type = status === "dismissed" ? "dismiss_alert" : "mark_alert_expected";
    return Response.json(
      await applyNow(getDb(), userId, masterKeys(), type, { alertIds: [id] }, deciderOf(user)),
    );
  } catch (e) {
    return actionError(e, "alerts.patch");
  }
}
