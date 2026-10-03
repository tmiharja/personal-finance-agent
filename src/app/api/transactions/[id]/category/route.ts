import { z } from "zod";
import { getDb } from "@/db/client";
import { ProposalError } from "@/server/actions/common";
import { proposeMerchantRule } from "@/server/actions/rules";
import { setTransactionCategory, TxnError } from "@/server/finance/transactions";
import { isSameOrigin, jsonError, sessionUserId } from "@/server/http";
import { logError } from "@/server/log";

const body = z.object({
  categoryId: z.uuid(),
  /** "one": this transaction only (a direct edit). "merchant": propose a rule. */
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
  try {
    if (parsed.data.scope === "one") {
      return Response.json(
        await setTransactionCategory(getDb(), userId, id, parsed.data.categoryId),
      );
    }
    return Response.json(await proposeMerchantRule(getDb(), userId, id, parsed.data.categoryId));
  } catch (e) {
    if (e instanceof TxnError) {
      return jsonError(e.code, e.code === "transaction_not_found" ? 404 : 400);
    }
    if (e instanceof ProposalError) return jsonError(e.code, 400);
    logError("transactions.category", e);
    return jsonError("internal_error", 500);
  }
}
