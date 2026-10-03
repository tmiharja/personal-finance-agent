import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;

// E2E runs a production build against a local Postgres (E2E_DATABASE_URL, migrated
// first) with the dev mail outbox on, so sign-in codes can be read without email.
// CHROMIUM_PATH lets CI or sandboxes point at a preinstalled browser.
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npm run build && npm run start -- -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      DATABASE_URL:
        process.env.E2E_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/finance_e2e",
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-123456",
      MASTER_KEY: "ZTJlLW1hc3Rlci1rZXktbm90LWZvci1wcm9kLTAwMDE=",
      DEV_MAIL_OUTBOX: "1",
      LLM_MOCK: "1",
      // Every e2e visitor is 127.0.0.1: lift the per-visitor demo limits.
      DEMO_WORKSPACES_PER_DAY: "10000",
      DEMO_QUESTIONS_PER_DAY: "10000",
      ANTHROPIC_API_KEY: "",
    },
  },
});
