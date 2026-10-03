import { z } from "zod";
import { getDb } from "@/db/client";
import { runAsk, type AskEvent } from "@/server/agent/ask";
import { isSameOrigin, jsonError, sessionUserId } from "@/server/http";
import { logError } from "@/server/log";

// The tool loop streams for up to a minute (the loop's own timeout).
export const maxDuration = 60;

const body = z.object({
  question: z.string().trim().min(1).max(1000),
  /** Earlier turns of this session's chat (kept by the browser only, PRD ASK-1). */
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
    .max(24)
    .default([]),
});

/** Ask: streams newline-delimited JSON events (see AskEvent). Read-only. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return jsonError("bad_origin", 403);
  const userId = await sessionUserId(request);
  if (!userId) return jsonError("unauthenticated", 401);
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("bad_request", 400);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AskEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      try {
        await runAsk({
          db: getDb(),
          userId,
          question: parsed.data.question,
          history: parsed.data.history,
          emit,
          signal: request.signal,
        });
      } catch (e) {
        logError("api.ask", e);
        emit({ t: "error", code: "ask_failed" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
