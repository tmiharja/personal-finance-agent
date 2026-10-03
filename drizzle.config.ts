import { defineConfig } from "drizzle-kit";
import { migrationUrl } from "./src/db/url";

// `npm run db:generate` writes SQL migrations to ./drizzle (committed).
// `npm run db:migrate` applies them (scripts/migrate.ts), preferring the direct
// (unpooled) connection from the Vercel Neon integration.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: migrationUrl(process.env) ?? "" },
  entities: { roles: true },
  strict: true,
});
