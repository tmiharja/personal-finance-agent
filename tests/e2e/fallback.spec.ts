import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { newEmail, signIn } from "./helpers";

const fixture = (name: string) =>
  join(process.cwd(), "evals", "fixtures", "synthetic", `${name}.pdf`);

test("an unknown layout is read with AI only when you say so", async ({ page, isMobile }) => {
  await signIn(page, newEmail(isMobile ? "aim" : "aid"));
  await page.goto("/app/import");

  // Declining leaves nothing behind.
  await page.getByLabel("Statement files").setInputFiles(fixture("sample-bank/2026-07"));
  const ask = page.getByRole("region", { name: "Read this statement with AI?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "No thanks" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByText(/doesn.t look like a DBS\/POSB or UOB statement/)).toBeVisible();

  // Agreeing reads it, and the preview asks you to check every row.
  await page.getByLabel("Statement files").setInputFiles(fixture("sample-bank/2026-08"));
  await page
    .getByRole("region", { name: "Read this statement with AI?" })
    .getByRole("button", { name: "Read it with AI" })
    .click();
  const card = page.getByRole("region", { name: /OTHER statement 20 Aug 2026/ });
  await expect(card).toBeVisible();
  await expect(card.getByText("AI-extracted, please review.").first()).toBeVisible();
  await expect(card.getByText("✓ Reconciled")).toHaveCount(1);
  await card.getByRole("button", { name: /Approve import/ }).click();
  await expect(card.getByText(/Imported \d+ transactions\./)).toBeVisible();
});

test("the admin page is the owner's only", async ({ page, isMobile }) => {
  await signIn(page, newEmail(isMobile ? "nam" : "nad"));
  const res = await page.goto("/app/admin");
  expect(res?.status()).toBe(404);
  await page.goto("/app/settings");
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);

  // ADMIN_EMAILS lists these addresses in the e2e server's env (one per project,
  // so the two projects' sign-in codes don't replace each other).
  await page.context().clearCookies();
  await signIn(page, `e2e-owner-${isMobile ? "m" : "d"}@example.com`);
  await page.goto("/app/settings");
  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page.getByRole("heading", { name: "Admin", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Eval scoreboard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Parsing, last 30 days" })).toBeVisible();
});
