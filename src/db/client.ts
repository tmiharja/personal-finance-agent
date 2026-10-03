import { Pool as NeonPool } from "@neondatabase/serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getEnv } from "@/env";
import * as schema from "./schema";

export type Schema = typeof schema;
/** Any Postgres driver (Neon, node-postgres, PGlite in tests) behind one type. */
export type AppDb = PgDatabase<PgQueryResultHKT, Schema>;

function isLocal(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Neon's WebSocket Pool in deployed environments: it supports interactive
 * transactions, which withUser() needs for SET LOCAL. Plain node-postgres for a
 * local Postgres in development and e2e tests.
 */
export function createDb(url: string): AppDb {
  if (isLocal(url)) return drizzlePg(new pg.Pool({ connectionString: url, max: 5 }), { schema });
  return drizzleNeon(new NeonPool({ connectionString: url }), { schema });
}

let cached: { url: string; db: AppDb } | undefined;

export function getDb(): AppDb {
  const url = getEnv().DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (cached?.url !== url) cached = { url, db: createDb(url) };
  return cached.db;
}
