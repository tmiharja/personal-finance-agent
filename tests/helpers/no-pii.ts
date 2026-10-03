import { sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { USER_TABLES } from "@/db/schema";
import { sqlRows } from "@/db/rows";

/**
 * Values that must never reach storage, logs or LLM payloads. All fictional:
 * the fixtures' persona, address and public test card numbers in every
 * printed format, plus identifiers assembled at runtime.
 */
export const FORBIDDEN: readonly string[] = (() => {
  const pans = ["4111111111111111", "5555555555554444", "4012888888881881", "4000056655665556"];
  const formats = pans.flatMap((p) => [
    p,
    p.match(/.{4}/g)!.join(" "),
    p.match(/.{4}/g)!.join("-"),
    p.slice(-4) + " ",
  ]);
  return [
    ...formats.filter((f) => f.length > 5),
    "ALEX TAN",
    "JORDAN TAN",
    "10 EXAMPLE AVENUE",
    "SAMPLE RESIDENCES",
    "alex.tan@example.com",
    ["S", "1234567", "D"].join(""),
    ["9123", "4567"].join(" "),
  ];
})();

/** Every row of every user table plus Better Auth tables, as one lowercase text blob. */
export async function dumpDatabase(db: AppDb): Promise<string> {
  const tables = [...USER_TABLES, "user", "session", "account", "verification", "passkey"];
  const parts: string[] = [];
  for (const t of tables) {
    const res = await db.execute(sql.raw(`select row_to_json(x)::text as j from "${t}" x`));
    for (const r of sqlRows<{ j: string }>(res)) parts.push(r.j);
  }
  return parts.join("\n").toLowerCase();
}

/** Returns the forbidden values (by index, never echoing them) found in a text blob. */
export function leaks(blob: string, extra: readonly string[] = []): number[] {
  const lower = blob.toLowerCase();
  return [...FORBIDDEN, ...extra]
    .map((v, i) => (lower.includes(v.toLowerCase()) ? i : -1))
    .filter((i) => i >= 0);
}
