import { expect, test, type Page } from "@playwright/test";

// Synthetic addresses only (example.com).
const newEmail = (tag: string) => `e2e-${tag}-${Date.now()}@example.com`;

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByText("We sent a 6-digit code")).toBeVisible();
  const res = await page.request.get(`/api/dev/outbox?email=${encodeURIComponent(email)}`);
  expect(res.ok()).toBe(true);
  const { code } = (await res.json()) as { code: string };
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/app");
}

test("landing page explains the product and links to sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Know where your money goes.");
  await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in or create an account" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("sets security headers", async ({ request }) => {
  const res = await request.get("/");
  const h = res.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-powered-by"]).toBeUndefined();
});

test("the app requires a session", async ({ page }) => {
  await page.goto("/app/transactions");
  await expect(page).toHaveURL(/\/login$/);
});

test("a forged session cookie is rejected by the server", async ({ page, context, baseURL }) => {
  await context.addCookies([
    { name: "better-auth.session_token", value: "forged.value", url: baseURL! },
  ]);
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
});

test("sign in with an emailed code, use the app shell, sign out", async ({ page, isMobile }) => {
  await signIn(page, newEmail(isMobile ? "m" : "d"));
  await expect(page.getByRole("heading", { name: "No statements yet" })).toBeVisible();
  await expect(page.getByLabel("Approvals: 0 pending")).toBeVisible();

  const nav = isMobile
    ? page.getByRole("navigation", { name: "App" })
    : page.getByRole("navigation", { name: "Primary" });
  await nav.getByRole("link", { name: "Transactions" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Transactions" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Transactions" }).first()).toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.goto("/app/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
});

test("a wrong code is refused", async ({ page }) => {
  const email = newEmail("bad");
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill("000000");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("That code didn't work")).toBeVisible();
});
