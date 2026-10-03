import { expect, type Page } from "@playwright/test";

// Synthetic addresses only (example.com).
export const newEmail = (tag: string) => `e2e-${tag}-${Date.now()}@example.com`;

export async function signIn(page: Page, email: string) {
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
