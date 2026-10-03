/**
 * Rows from a raw `db.execute(sql…)`. node-postgres, Neon and PGlite all return
 * `{ rows }`; the driver-agnostic database type leaves the result as unknown.
 */
export function sqlRows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}
