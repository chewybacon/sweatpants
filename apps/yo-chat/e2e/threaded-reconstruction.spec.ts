import { expect, test } from "@playwright/test";

test("threaded chat reconstructs a completed durable tool turn after refresh", async ({ page }) => {
  await page.goto("/chat/threaded/?scriptedRendering=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Threaded Chat" })).toBeVisible();
  await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("thread-create").click();
  await expect(page.getByText("Active")).toBeVisible();
  await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10_000 });

  const prompt = "deterministic pick card";
  const input = page.getByPlaceholder("Ask this thread to draw a card...");
  const send = page.getByRole("button", { name: "Send" });
  await input.fill(prompt);
  await expect(send).toBeEnabled({ timeout: 10_000 });
  await send.click();

  const block = page.getByTestId("tool-call-block").last();
  const card = block
    .locator("button:not([disabled])")
    .filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ })
    .first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const picked = (await card.textContent())?.trim();
  expect(picked).toBeTruthy();
  await card.click();

  await expect(block.getByText(`You picked: ${picked}`)).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByTestId("message-assistant").filter({
      hasText: "Thread reconstruction fixture complete.",
    }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 30_000 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("message-user").filter({ hasText: prompt })).toBeVisible();

  const replayed = page.getByTestId("tool-call-block").filter({ hasText: `You picked: ${picked}` });
  await expect(replayed).toHaveCount(1);
  await expect(
    replayed
      .locator("button")
      .filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ })
      .first(),
  ).toBeDisabled();
  await expect(
    page.getByTestId("message-assistant").filter({
      hasText: "Thread reconstruction fixture complete.",
    }),
  ).toBeVisible();
});
