import { expect, test, type Locator, type Page } from "@playwright/test";

async function openRenderingFixture(page: Page) {
  await page.goto("/chat/basic/?scriptedRendering=1", { waitUntil: "networkidle" });
  await page.evaluate(() =>
    window.localStorage.removeItem("basic-chat-scripted-rendering-conversation-id"),
  );
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Basic Chat" })).toBeVisible();
  await expect(page.getByText("Pipeline ready")).toBeVisible({ timeout: 30_000 });
}

async function sendFixture(page: Page, prompt: string, expectedMessageCount: number) {
  const input = page.getByPlaceholder("Type a message...");
  await input.fill(prompt);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(`${expectedMessageCount} messages`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("streaming...")).not.toBeVisible({ timeout: 30_000 });
}

function assistantMessages(page: Page): Locator {
  return page.locator(".bg-slate-800\\/50");
}

test("renders and preserves Markdown, KaTeX, and Mermaid SVG across turns", async ({ page }) => {
  await openRenderingFixture(page);

  await sendFixture(page, "render markdown fixture", 2);
  await sendFixture(page, "render math fixture", 4);
  await sendFixture(page, "render mermaid fixture", 6);

  const assistants = assistantMessages(page);
  await expect(assistants).toHaveCount(3);

  const markdown = assistants.nth(0);
  await expect(markdown.locator("h1")).toContainText("Rendering fixture");
  await expect(markdown.locator("strong")).toContainText("bold text");
  await expect(markdown.locator("li")).toHaveCount(2);
  await expect(markdown).not.toContainText("**bold text**");

  const math = assistants.nth(1);
  await expect(math.locator("h1")).toContainText("Math fixture");
  await expect(math.locator(".katex").first()).toBeVisible({ timeout: 30_000 });
  await expect(math.locator(".katex-display").first()).toBeVisible({ timeout: 30_000 });
  await expect(math).not.toContainText("$$");

  const mermaid = assistants.nth(2);
  await expect(mermaid.locator("h1")).toContainText("Mermaid fixture");
  await expect(mermaid.locator(".mermaid-diagram svg").first()).toBeVisible({ timeout: 30_000 });
  await expect(mermaid).not.toContainText("```mermaid");
});
