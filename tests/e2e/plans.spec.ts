import { expect, test, type Page } from "@playwright/test";

async function startDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Try the demo" }).click();
  await page.waitForURL("**/app", { timeout: 30_000 });
}

test("Overview shows budgets and last week; a budget changed in Settings shows up", async ({
  page,
}) => {
  await startDemo(page);
  const budgets = page.getByRole("region", { name: "Budgets" });
  await expect(budgets.getByRole("link", { name: /^Groceries: .* of S\$150\.00/ })).toBeVisible();
  await expect(budgets.getByText("Over budget", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Last week" })).toBeVisible();

  await budgets.getByRole("link", { name: "Change budgets" }).click();
  await expect(page).toHaveURL(/\/app\/settings#budgets$/);
  const groceries = page.getByLabel("Groceries", { exact: true });
  await groceries.fill("900");
  await groceries.press("Enter");
  await expect(groceries).toHaveValue("900.00");
  await page.goto("/app");
  await expect(
    page
      .getByRole("region", { name: "Budgets" })
      .getByRole("link", { name: /^Groceries: .* of S\$900\.00/ }),
  ).toBeVisible();
  // Recorded in Activity, undoable.
  await page.goto("/app/activity");
  await expect(
    page.getByRole("button", { name: "Undo: Budget S$900.00 a month for Groceries" }),
  ).toBeVisible();
});

test("export downloads a CSV and is recorded in Activity", async ({ page }) => {
  await startDemo(page);
  await page.goto("/app/transactions?merchant=Grab");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("transactions.csv");
  const text = await (await file.createReadStream()).toArray();
  const csv = Buffer.concat(text).toString("utf8");
  expect(csv).toContain("Date,Posted,Account,Merchant,Description,Category,Kind,Amount (SGD)");
  expect(csv).toContain('"Grab"');
  await page.goto("/app/activity");
  await expect(page.getByText(/^Export \d+ transactions to CSV/)).toBeVisible();
});

test("drafts: a fee waiver request to copy, and how to cancel a subscription", async ({ page }) => {
  await startDemo(page);
  await page.goto("/app/alerts");
  await page.getByRole("button", { name: "Draft a waiver request" }).first().click();
  const draft = page.getByRole("region", { name: /^Ask to waive the / });
  await expect(draft.getByText(/I was charged S\$[\d,.]+ plus GST/)).toBeVisible();
  await expect(
    draft.getByText("A draft for you to send yourself.", { exact: false }),
  ).toBeVisible();
  await page.goto("/app/subscriptions");
  await page.getByRole("button", { name: "How to cancel" }).first().click();
  await expect(page.getByRole("region", { name: /^How to cancel / })).toBeVisible();
});

test("a bill you add appears on Bills and can be changed", async ({ page }) => {
  await startDemo(page);
  await page.goto("/app/bills");
  const form = page.getByRole("form", { name: "Add a bill" });
  await form.getByLabel("From").fill("Sample Gym");
  await form.getByLabel("Due day").selectOption("5");
  await form.getByLabel("Usual amount (S$)").fill("99");
  await form.getByRole("button", { name: "Add bill" }).click();
  const item = page.getByRole("listitem").filter({ hasText: "Sample Gym" });
  await expect(item.getByText(/Added by you · Around the 5th each month/)).toBeVisible();
  await item.getByRole("button", { name: "Change the Sample Gym bill" }).click();
  await item.getByLabel("Due day").selectOption("20");
  await item.getByRole("button", { name: "Save" }).click();
  await expect(item.getByText(/Around the 20th each month/)).toBeVisible();
});
