// Standalone scripts (tsx) don't get Next's .env loading, so load the same files
// here: .env.local then .env. Variables already set in the shell win.
import { existsSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}
