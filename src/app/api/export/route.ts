import { getDb } from "@/db/client";
import { withUser } from "@/db/with-user";
import { applyNow } from "@/server/actions";
import { getUserCrypto } from "@/server/crypto/user-keys";
import { exportCsv, exportFilterSchema } from "@/server/finance/export";
import { deciderOf, isSameOrigin, jsonError, masterKeys, sessionUser } from "@/server/http";
import { actionError } from "@/server/proposal-route";

/**
 * Download your transactions as CSV (`export_csv`). POST, so it can't be
 * triggered by a link; recorded in Activity first; needs a sign-in in the last
 * 10 minutes (AUTH-3), except in the demo, whose data is fictional.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return jsonError("bad_origin", 403);
  const user = await sessionUser(request);
  if (!user) return jsonError("unauthenticated", 401);
  if (!user.fresh && !user.isDemo) return jsonError("reauth_required", 403);
  const parsed = exportFilterSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return jsonError("bad_request", 400);
  try {
    const db = getDb();
    const keys = masterKeys();
    await applyNow(db, user.id, keys, "export_csv", parsed.data, deciderOf(user));
    const { csv } = await withUser(db, user.id, async (tx) =>
      exportCsv(tx, await getUserCrypto(tx, user.id, keys), parsed.data),
    );
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="transactions.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return actionError(e, "export");
  }
}
