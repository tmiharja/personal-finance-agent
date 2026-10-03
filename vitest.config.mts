import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/no-pii/**/*.test.ts", "tests/private/**/*.test.ts"],
    environment: "node",
    // In-process Postgres (PGlite) boots per file; give it room on slow runners.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Tests never reach real services.
    env: {
      MASTER_KEY: "dW5pdC1tYXN0ZXIta2V5LW5vdC1mb3ItcHJvZC0wMDE=",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
      // Offline, deterministic model responses; a developer's real key is never used.
      LLM_MOCK: "1",
      ANTHROPIC_API_KEY: "",
    },
  },
});
