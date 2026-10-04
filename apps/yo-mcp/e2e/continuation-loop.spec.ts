import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("switch", { name: /Connect or disconnect/ }).click({ force: true });
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByText(/MCP\s+2026-07-28/)).toBeVisible();
  await page.locator('label[for$="-Tools"]').click();
});

test("cancel a card, confirm, then call echo twice on the same connection", async ({ page }) => {
  await page.getByRole("button", { name: "pick_card", exact: true }).click();
  await page.getByRole("button", { name: "Execute Tool", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Elicitation Request" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("group", { name: /Editor content/ })).toContainText(
    '"success": false',
  );

  await page.getByRole("button", { name: "confirm", exact: true }).click();
  await page.getByRole("textbox", { name: "action", exact: true }).fill("Run the local MCP test");
  await page.getByRole("button", { name: "Execute Tool", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox", { name: "confirmed", exact: true }).check();
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.getByRole("group", { name: /Editor content/ })).toContainText(
    '"confirmed": true',
  );

  for (const message of ["first independent call", "second independent call"]) {
    await page.getByRole("button", { name: "Close results", exact: true }).click();
    await page.getByRole("button", { name: "echo", exact: true }).click();
    await page.getByRole("textbox", { name: "message", exact: true }).fill(message);
    await page.getByRole("button", { name: "Execute Tool", exact: true }).click();
    await expect(page.getByRole("group", { name: /Editor content/ })).toContainText(
      `"echoed": "${message}"`,
    );
  }
  await page.screenshot({ path: "test-results/modern-continuation-loop.png", fullPage: true });
});
