import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { newEmail, signIn } from "./helpers";

const fixture = (name: string) =>
  join(process.cwd(), "evals", "fixtures", "synthetic", `${name}.pdf`);

test("upload a statement, review the preview, approve it", async ({ page, isMobile }) => {
  await signIn(page, newEmail(isMobile ? "im" : "id"));
  await page.goto("/app/import");
  await page.getByLabel("Statement PDFs").setInputFiles(fixture("dbs/2026-03"));

  const card = page.getByRole("region", { name: /DBS statement 14 Mar 2026/ });
  await expect(card).toBeVisible();
  await expect(card.getByText("✓ Reconciled")).toHaveCount(2);
  await expect(card.getByText("27 transactions on 2 cards")).toBeVisible();
  // Account numbers never reach the preview.
  await card.getByText("Show transactions").first().click();
  await expect(card.getByText("AUTOPAY", { exact: true }).first()).toBeVisible();
  await expect(card.getByText(/AC#/)).toHaveCount(0);

  await card.getByRole("button", { name: "Approve import (27)" }).click();
  await expect(card.getByText("Imported 27 transactions.")).toBeVisible();

  await page.goto("/app");
  const stats = page.getByRole("main").locator("dl");
  await expect(stats).toContainText("Cards2");
  await expect(stats).toContainText("Transactions27");

  // The same file again is refused.
  await page.goto("/app/import");
  await page.getByLabel("Statement PDFs").setInputFiles(fixture("dbs/2026-03"));
  await expect(page.getByText("You've already imported this file.")).toBeVisible();
});

test("a password-protected statement asks for its password", async ({ page, isMobile }) => {
  await signIn(page, newEmail(isMobile ? "pm" : "pd"));
  await page.goto("/app/import");
  await page.getByLabel("Statement PDFs").setInputFiles(fixture("variants/uob-2026-01-password"));
  await page.getByLabel(/password-protected/).fill("wrong");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("That password didn't open the file.")).toBeVisible();
  await page.getByLabel(/password-protected/).fill("alex0000");
  await page.getByRole("button", { name: "Unlock" }).click();
  const card = page.getByRole("region", { name: /UOB statement 13 Jan 2026/ });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Discard" }).click();
  await expect(card.getByText("Discarded. Nothing was imported.")).toBeVisible();
});

test("a pending import waits in Activity until reviewed", async ({ page, isMobile }) => {
  await signIn(page, newEmail(isMobile ? "am" : "ad"));
  await page.goto("/app/import");
  await page.getByLabel("Statement PDFs").setInputFiles(fixture("uob/2026-02"));
  await expect(page.getByRole("region", { name: /UOB statement/ })).toBeVisible();
  await expect(page.getByLabel("Approvals: 1 pending")).toBeVisible(); // header refreshes after the preview
  await page.goto("/app/activity");
  await page.getByRole("link", { name: "Review" }).click();
  await expect(page.getByRole("region", { name: /UOB statement/ })).toBeVisible();
});

test("a file that isn't a supported statement is refused", async ({ page, isMobile }) => {
  await signIn(page, newEmail(isMobile ? "xm" : "xd"));
  await page.goto("/app/import");
  await page.getByLabel("Statement PDFs").setInputFiles({
    name: "notes.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not really a pdf"),
  });
  await expect(page.getByText("Only PDF statements are supported for now.")).toBeVisible();
});
