import { test, expect } from "@playwright/test";

test("plan a trip through five prompts and revise within the original invocation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("switch", { name: /Connect or disconnect/ }).click({ force: true });
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.locator('label[for$="-Tools"]').click();
  await page.getByRole("button", { name: "plan_trip", exact: true }).click();
  await page.getByRole("textbox", { name: "traveler", exact: true }).fill("Ada");
  await page.getByRole("button", { name: "Execute Tool", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Elicitation Request" });
  await expect(dialog).toContainText("Ada, which city");
  await dialog.getByRole("textbox", { name: "city", exact: true }).fill("Kyoto");
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();

  await expect(dialog).toContainText("What would you like to do in Kyoto?");
  await dialog.getByRole("textbox", { name: "activity", exact: true }).click();
  await page.getByRole("option", { name: "museum", exact: true }).click();
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();

  await expect(dialog).toContainText("Ada: Kyoto, with a museum");
  await expect(dialog.getByRole("checkbox", { name: "confirmed", exact: true })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();

  await expect(dialog).toContainText("What would you like to do in Kyoto?");
  await dialog.getByRole("textbox", { name: "activity", exact: true }).click();
  await page.getByRole("option", { name: "park", exact: true }).click();
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();

  await expect(dialog).toContainText("Ada: Kyoto, with a park");
  await dialog.getByRole("checkbox", { name: "confirmed", exact: true }).check();
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const result = page.getByRole("group", { name: /Editor content/ });
  await expect(result).toContainText('"status": "planned"');
  await expect(result).toContainText('"traveler": "Ada"');
  await expect(result).toContainText('"city": "Kyoto"');
  await expect(result).toContainText('"activity": "park"');
  await page.screenshot({ path: "test-results/plan-trip.png", fullPage: true });
});
