import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { newEmail, signIn } from "./helpers";

const fixture = (name: string) =>
  join(process.cwd(), "evals", "fixtures", "synthetic", `${name}.pdf`);

test("upload a statement, review the preview, approve it", async ({ page, isMobile }) => {
  await signIn(page, newEmail(isMobile ? "im" : "id"));
  await page.goto("/app/import");
  await page.getByLabel("Statement files").setInputFiles(fixture("dbs/2026-03"));

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

  // Overview opens on the imported month, with spend by category.
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "March 2026" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Spend by category" })).toBeVisible();

  // The same file again is refused.
  await page.goto("/app/import");
  await page.getByLabel("Statement files").setInputFiles(fixture("dbs/2026-03"));
  await expect(page.getByText("You've already imported this file.")).toBeVisible();
});

test("a password-protected statement asks for its password", async ({ page, isMobile }) => {
  await signIn(page, newEmail(isMobile ? "pm" : "pd"));
  await page.goto("/app/import");
  await page.getByLabel("Statement files").setInputFiles(fixture("variants/uob-2026-01-password"));
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
  await page.getByLabel("Statement files").setInputFiles(fixture("uob/2026-02"));
  await expect(page.getByRole("region", { name: /UOB statement/ })).toBeVisible();
  await expect(page.getByLabel("Approvals: 1 pending")).toBeVisible(); // header refreshes after the preview
  await page.goto("/app/activity");
  await page.getByRole("link", { name: "Review" }).click();
  await expect(page.getByRole("region", { name: /UOB statement/ })).toBeVisible();
});

test("a file that isn't a supported statement is refused", async ({ page, isMobile }) => {
  await signIn(page, newEmail(isMobile ? "xm" : "xd"));
  await page.goto("/app/import");
  await page.getByLabel("Statement files").setInputFiles({
    name: "notes.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not really a pdf"),
  });
  await expect(page.getByText("Upload a PDF statement or your bank's CSV export.")).toBeVisible();
  // A CSV that isn't a supported bank export.
  await page.getByLabel("Statement files").setInputFiles({
    name: "budget.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("date,amount\n2026-01-01,12.30\n"),
  });
  // An unknown layout is offered to the AI reader first; declining refuses it.
  await page
    .getByRole("region", { name: "Read this statement with AI?" })
    .getByRole("button", { name: "No thanks" })
    .click();
  await expect(page.getByText(/doesn't look like a DBS\/POSB or UOB statement/)).toBeVisible();
});

test("a bank CSV export imports, and its card bill payments pair with the card", async ({
  page,
  isMobile,
}) => {
  await signIn(page, newEmail(isMobile ? "bm" : "bd"));
  await page.goto("/app/import");
  await page.getByLabel("Statement files").setInputFiles(fixture("dbs/2026-03"));
  const cards = page.getByRole("region", { name: /DBS statement 14 Mar 2026/ });
  await cards.getByRole("button", { name: /Approve import/ }).click();
  await expect(cards.getByText(/Imported 27 transactions/)).toBeVisible();

  await page.goto("/app/import");
  await page
    .getByLabel("Statement files")
    .setInputFiles(join(process.cwd(), "evals", "fixtures", "synthetic", "posb", "2026-03.csv"));
  const bank = page.getByRole("region", { name: /DBS statement 31 Mar 2026/ });
  await expect(bank.getByText(/DBS\/POSB bank-account statement/)).toBeVisible();
  await expect(bank.getByText("Posb Sample Savings Account")).toBeVisible();
  // The CSV export prints no opening balance, so there's nothing to reconcile against.
  await expect(bank.getByText("No balances to check")).toBeVisible();
  await expect(bank.getByText(/Matched with your other accounts: 2 card payments/)).toBeVisible();
  // People's names never reach the preview.
  await bank.getByText("Show transactions").first().click();
  await expect(bank.getByText("PAYNOW TRANSFER OUT").first()).toBeVisible();
  await expect(bank.getByText(/JORDAN|ALEX/)).toHaveCount(0);
  // Unverifiable totals need an explicit "import anyway".
  await bank.getByLabel(/Import anyway/).check();
  await bank.getByRole("button", { name: /Approve import/ }).click();
  await expect(bank.getByText(/2 matched with your other accounts/)).toBeVisible();
});
