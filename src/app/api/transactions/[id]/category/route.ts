import { z } from "zod";
import { getDb } from "@/db/client";
import { applyNow, propose } from "@/server/actions";
import { isSameOrigin, jsonError, masterKeys, sessionUserId } from "@/server/http";
import { actionError } from "@/server/proposal-route";

const body = z.object({
  categoryId: z.uuid(),
  /** "one": this transaction only (applied now, undoable). "merchant": propose a rule. */
  scope: z.enum(["one", "merchant"]),
});

/** PRD CAT-5: correct a category for one row, or propose a rule for the merchant. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return jsonError("bad_origin", 403);
  const userId = await sessionUserId(request);
  if (!userId) return jsonError("unauthenticated", 401);
  const { id } = await params;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !z.uuid().safeParse(id).success) return jsonError("bad_request", 400);
  const { categoryId, scope } = parsed.data;
  try {
    if (scope === "one") {
      return Response.json(
        await applyNow(getDb(), userId, masterKeys(), "recategorise_transactions", {
          transactionIds: [id],
          categoryId,
        }),
      );
    }
    return Response.json(
      await propose(getDb(), userId, "user", "create_rule", { transactionId: id, categoryId }),
    );
  } catch (e) {
    return actionError(e, "transactions.category");
  }
}
