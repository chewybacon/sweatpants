import { expect, test } from "@playwright/test";

test("ProgramDriver journal inspector reads a known conversation journal", async ({ page }) => {
  await page.goto("/lab/durability/journal");
  await expect(
    page.getByRole("heading", { name: "ProgramDriver Journal Inspector" }),
  ).toBeVisible();
  const inspect = page.getByRole("button", { name: "Inspect" });
  await expect(inspect).toBeEnabled();
  await page.getByPlaceholder("conversation ID").fill("e2e-empty-journal");
  await inspect.click();
  await expect(page.getByText("Records")).toBeVisible();
  await expect(page.getByText("Pending pulls")).toBeVisible();
  await expect(page.getByText("TaskOpened")).not.toBeVisible();
});
