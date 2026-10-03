import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth/auth";
import { logError } from "@/server/log";

// Unhandled errors would be printed by Next with their full detail (database
// errors include the failing row, e.g. an email). Log class and code only.
async function handle(request: Request): Promise<Response> {
  try {
    return await getAuth().handler(request);
  } catch (error) {
    logError("auth.handler", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

export const { GET, POST } = toNextJsHandler(handle);
