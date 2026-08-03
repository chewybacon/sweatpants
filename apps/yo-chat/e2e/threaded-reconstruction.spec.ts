import { expect, test } from "@playwright/test";

test("threaded chat reconstructs a completed durable tool turn after refresh", async ({ page }) => {
  await page.goto("/chat/threaded/?scriptedRendering=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Threaded Chat" })).toBeVisible();
  await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10_000 });
  const activeThread = page.locator('[data-testid="thread-item"][aria-pressed="true"]');
  const previousThreadId = await activeThread.getAttribute("data-thread-id");
  await page.getByTestId("thread-create").click();
  await expect.poll(() => activeThread.getAttribute("data-thread-id")).not.toBe(previousThreadId);
  await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10_000 });

  const prompt = "deterministic pick card";
  const input = page.getByPlaceholder("Ask this thread to draw a card...");
  await expect(input).toBeEnabled();
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

  // Frontend-local render records are intentionally not durable checkpoint
  // state. Refresh restores the host tree and settled assistant result, not a
  // native card component or its local response presentation.
  const replayed = page.getByTestId("tool-call-block").last();
  await expect(replayed).toBeVisible();
  await expect(replayed.locator("button")).toHaveCount(0);
  await expect(
    page.getByTestId("message-assistant").filter({
      hasText: "Thread reconstruction fixture complete.",
    }),
  ).toBeVisible();
});
