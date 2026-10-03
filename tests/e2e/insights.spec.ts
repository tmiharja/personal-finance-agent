import { expect, test, type Page } from "@playwright/test";

async function startDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Try the demo" }).click();
  await page.waitForURL("**/app", { timeout: 30_000 });
  await expect(page.getByText(/exploring a demo with fictional data/)).toBeVisible();
}

test("the demo opens on a month with spend by category and a 12-month trend", async ({ page }) => {
  await startDemo(page);
  // The latest month with transactions (the demo's last statement runs into September).
  await expect(page.getByRole("heading", { name: "September 2026" })).toBeVisible();
  const stats = page.getByRole("main").locator("dl");
  await expect(stats).toContainText("Spent");
  await expect(stats).toContainText("Card payments");
  // Income from the bank accounts, with own-account transfers left out.
  await expect(stats).toContainText("Income");
  await expect(stats).toContainText(/transfers excluded/);
  await expect(page.getByText(/In your bank accounts/)).toBeVisible();
  // Twelve months, each reachable by keyboard and screen reader.
  await expect(page.getByRole("link", { name: /^[A-Z][a-z]{2} 20\d\d: S\$/ })).toHaveCount(12);
  await page.getByRole("link", { name: /^Mar 2026: S\$/ }).click();
  await expect(page.getByRole("heading", { name: "March 2026" })).toBeVisible();
  // A category bar leads to exactly those transactions.
  await page.getByRole("link", { name: /^Dining: S\$/ }).click();
  await expect(page).toHaveURL(/category=Dining/);
  await expect(page).toHaveURL(/from=2026-03-01/);
  await expect(page.getByText(/transactions · 1 Mar 2026 – 31 Mar 2026 · Dining/)).toBeVisible();
});

test("correcting a merchant proposes a rule, which changes nothing until approved", async ({
  page,
}) => {
  await startDemo(page);
  await page.goto("/app/transactions?merchant=Starbucks");
  const count = Number(
    (await page
      .getByText(/^\d+ transactions/)
      .first()
      .textContent())!.match(/^(\d+)/)![1],
  );
  expect(count).toBeGreaterThan(1);
  await page
    .getByLabel(/^Category for Starbucks/)
    .first()
    .selectOption({ label: "Health" });
  await page.getByRole("button", { name: /All Starbucks transactions/ }).click();

  const card = page.getByRole("region", { name: "Rule for Starbucks" });
  await expect(card.getByText("Always categorise Starbucks as Health")).toBeVisible();
  await expect(card.getByText(`${count} × Dining → Health`)).toBeVisible();
  // Waiting in Activity, and nothing has changed yet.
  await expect(page.getByRole("link", { name: "Approvals: 1 pending" })).toBeVisible();
  await page.goto("/app/transactions?merchant=Starbucks&category=Health");
  await expect(page.getByText("No transactions match these filters.")).toBeVisible();

  await page.goto("/app/activity");
  await page
    .getByRole("region", { name: "Rule for Starbucks" })
    .getByRole("button", { name: "Approve" })
    .click();
  // The card leaves the pending list once approved; the history says what happened.
  await expect(page.getByText("Done · Rule: Starbucks → Health · system")).toBeVisible();
  await page.goto("/app/transactions?merchant=Starbucks&category=Health");
  await expect(page.getByText(new RegExp(`^${count} transactions`))).toBeVisible();
});

test("Ask answers from the data with a link to the transactions", async ({ page, isMobile }) => {
  await startDemo(page);
  if (isMobile)
    await page
      .getByRole("navigation", { name: "App" })
      .getByRole("button", { name: "Ask" })
      .click();
  else await page.getByRole("banner").getByRole("button", { name: "Ask" }).click();
  const panel = page.getByRole("dialog", { name: "Ask about your spending" });
  await expect(panel).toBeVisible();
  await panel.getByLabel("Your question").fill("What did I spend on dining in Q1 2026?");
  await panel.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(
    panel.getByText(/You spent S\$[\d,]+\.\d\d on Dining in Q1 2026 \(1 Jan – 31 Mar\)/),
  ).toBeVisible();
  await panel.getByRole("link", { name: /^View \d+ transactions$/ }).click();
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(/category=Dining/);
  await expect(page).toHaveURL(/from=2026-01-01&to=2026-03-31/);
});

test("imports are off in the demo", async ({ page }) => {
  await startDemo(page);
  // A second click from the same browser reuses the workspace instead of failing.
  const again = await page.request.post("/api/demo", {
    headers: { origin: new URL(page.url()).origin },
  });
  expect(await again.json()).toEqual({ ok: true, existing: true });
  await page.goto("/app/import");
  await expect(page.getByRole("heading", { name: "Imports are off in the demo" })).toBeVisible();
  const res = await page.request.post("/api/import", {
    headers: { origin: new URL(page.url()).origin },
    multipart: {
      file: { name: "x.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") },
    },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: "demo_read_only" });
});

test("bank transactions: PayNow names are never shown, and a transfer can be confirmed as your own", async ({
  page,
}) => {
  await startDemo(page);
  await page.goto("/app/transactions?merchant=PayNow%20transfer");
  const rows = page.getByRole("row");
  await expect(rows.filter({ hasText: "PAYNOW TRANSFER OUT" }).first()).toBeVisible();
  // Uncategorised isn't a choice in the picker, but it still shows as the current value.
  await expect(
    rows.filter({ hasText: "PAYNOW TRANSFER OUT" }).first().locator("select option:checked"),
  ).toHaveText("Uncategorised");
  await expect(page.getByText(/JORDAN|ALEX/)).toHaveCount(0);
  // The own-account FAST transfers were matched across accounts and are locked.
  await page.goto("/app/transactions?merchant=FAST%20transfer");
  await expect(page.getByText("matched across accounts").first()).toBeVisible();
  // An unmatched PayNow in can be confirmed as a transfer between your own accounts.
  await page.goto("/app/transactions?merchant=PayNow%20transfer");
  const incoming = rows.filter({ hasText: "PAYNOW TRANSFER IN" }).first();
  await incoming.getByRole("combobox").selectOption({ label: "Transfers" });
  await expect(page.getByText(/money moving between your own accounts/)).toBeVisible();
  await expect(page.getByRole("button", { name: /All PayNow transfer transactions/ })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "This transaction only" }).click();
  await expect(incoming.locator("select option:checked")).toHaveText("Transfers");
});
