// Finishes a MASTER_KEY rotation: re-wraps every user's data key under the
// current MASTER_KEY (MASTER_KEY_PREVIOUS must still be set). Remove
// MASTER_KEY_PREVIOUS only after this prints remaining: 0.
import "./load-env";
import { createDb } from "../src/db/client";
import { databaseUrl } from "../src/db/url";
import { masterKeysFromEnv } from "../src/server/crypto/envelope";
import { rewrapAllUserKeys } from "../src/server/crypto/user-keys";

const url = databaseUrl(process.env);
if (!url) {
  console.error("Set DATABASE_URL to rewrap keys.");
  process.exit(1);
}
const keys = masterKeysFromEnv({
  MASTER_KEY: process.env.MASTER_KEY,
  MASTER_KEY_ID: Number(process.env.MASTER_KEY_ID ?? 1),
  MASTER_KEY_PREVIOUS: process.env.MASTER_KEY_PREVIOUS,
});
const result = await rewrapAllUserKeys(createDb(url), keys);
console.log(JSON.stringify({ event: "keys.rewrapped", ...result }));
process.exit(result.remaining === 0 ? 0 : 1);
