import { z } from "zod";
import { getDb } from "@/db/client";
import { setSubscriptionIgnored } from "@/server/detect/read";
import { isSameOrigin, jsonError, sessionUserId } from "@/server/http";

const body = z.object({ ignored: z.boolean() });

/** Ignore a detected subscription (or show it again). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return jsonError("bad_origin", 403);
  const userId = await sessionUserId(request);
  if (!userId) return jsonError("unauthenticated", 401);
  const { id } = await params;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !z.uuid().safeParse(id).success) return jsonError("bad_request", 400);
  const ok = await setSubscriptionIgnored(getDb(), userId, id, parsed.data.ignored);
  return ok ? Response.json({ ok: true }) : jsonError("subscription_not_found", 404);
}
