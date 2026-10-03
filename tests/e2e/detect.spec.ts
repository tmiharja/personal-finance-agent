import { expect, test, type Page } from "@playwright/test";

async function startDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Try the demo" }).click();
  await page.waitForURL("**/app", { timeout: 30_000 });
}

test("the demo's subscriptions include a price rise and a trial that became paid", async ({
  page,
}) => {
  await startDemo(page);
  await expect(page.getByRole("link", { name: /Subscriptions S\$[\d,.]+ a month/ })).toBeVisible();
  await page.goto("/app/subscriptions");
  await expect(page.getByText(/S\$[\d,.]+ a month across \d+ running subscriptions/)).toBeVisible();
  await expect(page.getByText("Price rose from S$17.98 to S$19.98 on 5 May 2026.")).toBeVisible();
  // Ignoring one takes it out of the list and the total.
  await page.getByRole("button", { name: "Ignore Spotify" }).click();
  await expect(page.getByRole("link", { name: "Spotify" })).toHaveCount(0);
  await expect(page.getByText("1 ignored")).toBeVisible();
});

test("alerts explain themselves and can be dismissed and reopened", async ({ page }) => {
  await startDemo(page);
  await page.goto("/app/alerts");
  const dup = page.getByRole("listitem").filter({ hasText: "Possible duplicate" });
  await expect(dup.getByText(/Two charges of S\$89\.90 at Lazada within 48 hours/)).toBeVisible();
  await expect(page.getByText("Card fee", { exact: true })).toBeVisible();
  await expect(page.getByText(/Annual fee of S\$196\.20 plus GST of S\$17\.66/)).toBeVisible();
  await dup.getByRole("button", { name: "Dismiss: Possible duplicate" }).click();
  await expect(page.getByText(/Two charges of S\$89\.90/)).toHaveCount(0);
  await page.getByRole("link", { name: "Dismissed and expected" }).click();
  await page.getByRole("button", { name: "Reopen: Possible duplicate" }).click();
  await page.getByRole("link", { name: "Open", exact: true }).click();
  await expect(page.getByText(/Two charges of S\$89\.90/)).toBeVisible();
});

test("bills show each card's due date and the recurring bills", async ({ page }) => {
  await startDemo(page);
  await page.goto("/app/bills");
  const cards = page.getByRole("region", { name: "Card payments" }).getByRole("listitem");
  await expect(cards).toHaveCount(4);
  await expect(page.getByRole("link", { name: "Singtel" })).toBeVisible();
  await expect(page.getByText(/Around the 19th each month/)).toBeVisible();
});

test("Ask answers subscription questions with a link to Subscriptions", async ({
  page,
  isMobile,
}) => {
  await startDemo(page);
  if (isMobile)
    await page
      .getByRole("navigation", { name: "App" })
      .getByRole("button", { name: "Ask" })
      .click();
  else await page.getByRole("banner").getByRole("button", { name: "Ask" }).click();
  const panel = page.getByRole("dialog", { name: "Ask about your spending" });
  await panel.getByRole("button", { name: "What do my subscriptions cost each month?" }).click();
  await expect(panel.getByText(/running subscriptions cost S\$[\d,]+\.\d\d a month/)).toBeVisible();
  await panel.getByRole("link", { name: "Open Subscriptions" }).click();
  await expect(page).toHaveURL(/\/app\/subscriptions$/);
});
