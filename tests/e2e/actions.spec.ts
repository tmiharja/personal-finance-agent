import { expect, test, type Page } from "@playwright/test";

async function startDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Try the demo" }).click();
  await page.waitForURL("**/app", { timeout: 30_000 });
}

async function openAsk(page: Page, isMobile: boolean) {
  if (isMobile)
    await page
      .getByRole("navigation", { name: "App" })
      .getByRole("button", { name: "Ask" })
      .click();
  else await page.getByRole("banner").getByRole("button", { name: "Ask" }).click();
  return page.getByRole("dialog", { name: "Ask about your spending" });
}

async function askFor(page: Page, panel: ReturnType<Page["getByRole"]>, question: string) {
  await panel.getByRole("textbox").fill(question);
  await panel.getByRole("textbox").press("Enter");
}

test("Ask suggests a change; it applies only on approval, and can be undone", async ({
  page,
  isMobile,
}) => {
  await startDemo(page);
  const panel = await openAsk(page, isMobile);
  await askFor(page, panel, "Set a budget of S$450 a month for Dining");
  const card = panel.getByRole("region", { name: "Budget S$450.00 a month for Dining" });
  await expect(
    card.getByText("Suggested by Ask. Nothing changes until you approve."),
  ).toBeVisible();
  await expect(panel.getByText(/I've suggested it/)).toBeVisible();
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByText("Done. You can undo it from Activity for 30 days.")).toBeVisible();

  await page.goto("/app/activity");
  const history = page.getByRole("region", { name: "History" });
  const item = history
    .getByRole("listitem")
    .filter({ hasText: "Budget S$450.00 a month for Dining" });
  await expect(item.getByText(/^Done · Ask suggested, you approved · /)).toBeVisible();
  await item.getByRole("button", { name: "Undo: Budget S$450.00 a month for Dining" }).click();
  await expect(item.getByText(/^Undone · Ask/)).toBeVisible();
  await expect(item.getByRole("button", { name: /Undo/ })).toHaveCount(0);

  // Filter the history by who suggested it.
  await page.getByLabel("Who").selectOption({ label: "Ask" });
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page).toHaveURL(/who=agent/);
  await expect(history.getByRole("listitem")).toHaveCount(1);
});

test("several suggestions can be approved together", async ({ page, isMobile }) => {
  await startDemo(page);
  const panel = await openAsk(page, isMobile);
  await askFor(page, panel, "Set a budget of S$300 a month for Groceries");
  await expect(panel.getByRole("region", { name: /Groceries/ })).toBeVisible();
  await askFor(page, panel, "Set a budget of S$120 a month for Transport");
  await expect(panel.getByRole("region", { name: /Transport/ })).toBeVisible();

  await page.goto("/app/activity");
  const pending = page.getByRole("region", { name: "Waiting for approval" });
  await pending.getByLabel("Select all").check();
  await pending.getByRole("button", { name: "Approve selected (2)" }).click();
  await expect(
    pending.getByText("Approved 2. You can undo each from the history below."),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "History" }).getByRole("button", { name: /^Undo: Budget/ }),
  ).toHaveCount(2);
});

test("dismissing an alert is undoable from Activity", async ({ page }) => {
  await startDemo(page);
  await page.goto("/app/alerts");
  await page.getByRole("button", { name: "Dismiss: Possible duplicate" }).click();
  await expect(page.getByText(/Two charges of S\$89\.90/)).toHaveCount(0);
  await page.goto("/app/activity");
  await page.getByRole("button", { name: /^Undo: Dismiss: possible duplicate/ }).click();
  await expect(page.getByText(/^Undone · You/)).toBeVisible();
  await page.goto("/app/alerts");
  await expect(page.getByText(/Two charges of S\$89\.90/)).toBeVisible();
});
