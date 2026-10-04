// The eval scoreboard: runs every measure over the synthetic household in a
// throwaway in-process Postgres and writes evals/results.json (codes and counts
// only), which the admin page shows. `npm run eval -- --live` reads the
// unknown-layout fixtures with the real model (needs ANTHROPIC_API_KEY); by
// default the offline extractor stands in, so the run is free and repeatable.
import "./load-env";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { AppDb } from "../src/db/client";
import * as schema from "../src/db/schema";
import { runEvals } from "../src/server/evals/run";
import { getLlm } from "../src/server/llm/client";
import { mockLlm } from "../src/server/llm/mock";

const live = process.argv.includes("--live");
if (!live) process.env.LLM_MOCK = "1";
const llm = live ? await getLlm() : mockLlm;
if (!llm) {
  console.error("--live needs ANTHROPIC_API_KEY.");
  process.exit(1);
}

const client = new PGlite();
const db = drizzle(client, { schema }) as unknown as AppDb;
await migrate(drizzle(client, { schema }), { migrationsFolder: "drizzle" });
await db
  .insert(schema.user)
  .values({ id: "eval", name: "eval", email: "eval@example.com", emailVerified: true });

const results = await runEvals({
  db,
  keys: { current: { id: 1, key: randomBytes(32) } },
  llm,
  model: process.env.MODEL_EXTRACT ?? "claude-haiku-4-5",
});
await client.close();

const out = { generatedOn: new Date().toISOString().slice(0, 10), ...results };
writeFileSync("evals/results.json", JSON.stringify(out, null, 2) + "\n");
for (const s of results.suites)
  console.log(`${s.ok ? "ok  " : "FAIL"} ${s.id}: ${s.pass}/${s.total}`);
if (results.suites.some((s) => !s.ok)) process.exit(1);
