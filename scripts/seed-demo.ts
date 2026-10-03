// Seeds the fictional demo user ("Alex Tan", synthetic fixtures only) into the
// database in DATABASE_URL, then runs the detectors. "Try the demo" does the
// same for an ephemeral per-visitor user (src/server/demo/workspace.ts).
import "./load-env";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { user } from "../src/db/schema";
import { databaseUrl } from "../src/db/url";
import { masterKeysFromEnv } from "../src/server/crypto/envelope";
import { seedDemoWorkspace } from "../src/server/demo/seed";
import { runDetectors } from "../src/server/detect/run";

const DEMO_USER = { id: "demo-alex-tan", name: "Alex Tan (demo)", email: "demo@example.com" };

const url = databaseUrl(process.env);
if (!url) {
  console.error("Set DATABASE_URL to seed the demo workspace.");
  process.exit(1);
}
const db = createDb(url);
const keys = masterKeysFromEnv({
  MASTER_KEY: process.env.MASTER_KEY,
  MASTER_KEY_ID: Number(process.env.MASTER_KEY_ID ?? 1),
  MASTER_KEY_PREVIOUS: process.env.MASTER_KEY_PREVIOUS,
});
const [existing] = await db.select().from(user).where(eq(user.id, DEMO_USER.id));
if (!existing) await db.insert(user).values({ ...DEMO_USER, emailVerified: true });
const result = await seedDemoWorkspace(db, DEMO_USER.id, keys);
const detected = await runDetectors(db, DEMO_USER.id, keys);
console.log(JSON.stringify({ event: "demo.seeded", ...result, ...detected }));
process.exit(0);
