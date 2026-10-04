import { getDb } from "@/db/client";
import { getEnv } from "@/env";
import { isSameOrigin, jsonError, masterKeys, sessionUser } from "@/server/http";
import { ImportError, previewImport } from "@/server/import/service";
import { PdfError } from "@/server/ingest/pdf";
import { ParseError } from "@/server/ingest/parsers";
import { logError } from "@/server/log";
import { PiiViolation } from "@/server/pii/firewall";

export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024; // under Vercel's 4.5 MB request limit

/**
 * Upload one statement (PDF, or a bank's CSV export) → parsed, sanitised preview
 * + a pending commit_import proposal. The file and any PDF password live only
 * for this request.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return jsonError("bad_origin", 403);
  const me = await sessionUser(request);
  if (me?.isDemo) return jsonError("demo_read_only", 403);
  const userId = me?.id;
  if (!userId) return jsonError("unauthenticated", 401);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES + 64 * 1024)
    return jsonError("too_large", 413);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("bad_request", 400);
  }
  const file = form.get("file");
  const password = form.get("password");
  // "Read it with AI": only after you chose it for a layout no parser reads (IMP-5).
  const ai = form.get("ai") === "1";
  if (!(file instanceof File)) return jsonError("bad_request", 400);
  if (file.size > MAX_BYTES) return jsonError("too_large", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // A PDF statement, or a bank's CSV export (sniffed by its header rows when parsed).
  const isPdf = new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
  const isCsv = /\.csv$/i.test(file.name) || file.type === "text/csv";
  if (!isPdf && !isCsv) return jsonError("unsupported_file", 415);

  try {
    const preview = await previewImport(getDb(), userId, masterKeys(), {
      bytes,
      password: typeof password === "string" && password ? password : undefined,
      ai,
    });
    return Response.json(preview);
  } catch (e) {
    if (e instanceof ParseError && e.code === "unsupported_format") {
      // Tell the page whether it can offer the AI fallback for this file.
      const env = getEnv();
      return Response.json(
        { error: e.code, aiAvailable: Boolean(env.ANTHROPIC_API_KEY || env.LLM_MOCK) },
        { status: 422 },
      );
    }
    if (e instanceof PdfError || e instanceof ParseError) return jsonError(e.code, 422);
    if (e instanceof PiiViolation) return jsonError("pii_blocked", 422);
    if (e instanceof ImportError) {
      return jsonError(
        e.code,
        e.code === "already_imported" ? 409 : e.code === "rate_limited" ? 429 : 400,
      );
    }
    logError("import.preview", e);
    return jsonError("internal_error", 500);
  }
}
