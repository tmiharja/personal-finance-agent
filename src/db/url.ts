/**
 * Where the Postgres connection strings come from.
 *
 * Connecting Neon through the Vercel Marketplace names the variables after an
 * "environment variable prefix": the default `DATABASE` gives DATABASE_URL and
 * DATABASE_URL_UNPOOLED. If the project already has a DATABASE_URL, Vercel
 * refuses that prefix, so connect with the prefix `NEON` instead. Integration
 * versions differ on the shape (NEON_URL or NEON_DATABASE_URL), so both are
 * accepted.
 *
 * The NEON_* names come first: they can only come from connecting Neon with
 * that prefix, so a leftover DATABASE_URL can't shadow them.
 */
export const POOLED_URL_NAMES = ["NEON_URL", "NEON_DATABASE_URL", "DATABASE_URL"] as const;

/** Direct (unpooled) connections, preferred for migrations. */
export const UNPOOLED_URL_NAMES = [
  "NEON_URL_UNPOOLED",
  "NEON_DATABASE_URL_UNPOOLED",
  "DATABASE_URL_UNPOOLED",
] as const;

type Source = Record<string, string | undefined>;

function firstSet(source: Source, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = source[name];
    if (value) return value;
  }
  return undefined;
}

/** Pooled connection string for the app (Neon's HTTP driver). */
export function databaseUrl(source: Source): string | undefined {
  return firstSet(source, POOLED_URL_NAMES);
}

/** Connection string for drizzle-kit migrations: direct if available, else pooled. */
export function migrationUrl(source: Source): string | undefined {
  return firstSet(source, UNPOOLED_URL_NAMES) ?? databaseUrl(source);
}
