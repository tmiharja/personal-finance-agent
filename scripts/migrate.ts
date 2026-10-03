// Applies the SQL migrations in ./drizzle. Uses a direct TCP connection
// (node-postgres) for both local Postgres and Neon's unpooled URL.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { migrationUrl } from "../src/db/url";

const url = migrationUrl(process.env);
if (!url) {
  console.error("Set DATABASE_URL (or DATABASE_URL_UNPOOLED) to run migrations.");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  console.log("migrations applied");
} finally {
  await pool.end();
}
