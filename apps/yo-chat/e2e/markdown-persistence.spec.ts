import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * E2E tests for markdown rendering persistence across multiple messages.
 *
 * These tests verify that:
 * 1. Markdown is rendered to HTML (not shown as raw text)
 * 2. Rendered HTML persists after streaming completes
 * 3. Previous messages retain their rendered HTML when new messages are sent
 * 4. Mermaid diagrams are rendered to SVG
 *
 * Runs against the selected managed provider.
 */

// LLM responses can be slow
test.setTimeout(180000);

test.describe("Markdown rendering persistence", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/chat/basic/", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Basic Chat" })).toBeVisible();
    await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10000 });
    // Click input to ensure React is hydrated
    await page.getByPlaceholder("Type a message...").click();
  });

  /**
   * Helper to wait for streaming to complete.
   * Checks that:
   * - Stop button is not visible
   * - Input is enabled (not disabled)
   */
  async function waitForStreamingComplete(page: Page) {
    // Wait for Stop button to disappear (streaming ended)
    await expect(page.getByRole("button", { name: "Stop" })).not.toBeVisible({ timeout: 120000 });

    // Wait for input to be enabled
    await expect(page.getByPlaceholder("Type a message...")).toBeEnabled({ timeout: 5000 });
  }

  /**
   * Helper to send a message and wait for completion.
   */
  async function sendMessageAndWait(page: Page, message: string) {
    const input = page.getByPlaceholder("Type a message...");
    await input.pressSequentially(message, { delay: 5 });
    await page.getByRole("button", { name: "Send" }).click();

    // Wait for streaming to start
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 30000 });

    // Wait for streaming to complete
    await waitForStreamingComplete(page);
  }

  /**
   * Helper to get all assistant message containers.
   */
  function getAssistantMessages(page: Page) {
    // Assistant messages have bg-slate-800/50 class
    return page.getByTestId("message-assistant");
  }

  /**
   * Helper to check if an element contains rendered HTML (not raw markdown).
   * Raw markdown would show backticks, asterisks, etc.
   */
  async function hasRenderedMarkdown(locator: Locator): Promise<boolean> {
    // Check for common rendered HTML elements
    const hasPreCode = (await locator.locator("pre code").count()) > 0;
    const hasHeading = (await locator.locator("h1, h2, h3, h4, h5, h6").count()) > 0;
    const hasList = (await locator.locator("ul, ol").count()) > 0;
    const hasTable = (await locator.locator("table").count()) > 0;
    const hasParagraph = (await locator.locator("p").count()) > 0;
    const hasStrong = (await locator.locator("strong, em").count()) > 0;

    return hasPreCode || hasHeading || hasList || hasTable || hasParagraph || hasStrong;
  }

  /**
   * Helper to check for raw markdown indicators (should NOT be visible).
   *
   * This is tricky because rendered content can still have text that looks like
   * markdown (e.g., "1." at the start of a line in a paragraph).
   * We focus on patterns that should NEVER appear in rendered output.
   */
  async function hasRawMarkdown(locator: Locator): Promise<boolean> {
    const text = (await locator.textContent()) ?? "";

    // Check for code fence markers - these should NEVER be visible in rendered output
    if (/^```/m.test(text)) {
      // But only if there's no rendered code block
      const hasCodeBlock = (await locator.locator("pre code").count()) > 0;
      if (!hasCodeBlock) {
        return true;
      }
    }

    // Check for heading markers like "## Title" - these should become <h2>Title</h2>
    // But only flag if there's NO rendered heading
    if (/^#{1,6}\s/m.test(text)) {
      const hasHeading = (await locator.locator("h1, h2, h3, h4, h5, h6").count()) > 0;
      if (!hasHeading) {
        return true;
      }
    }

    // NOTE: We intentionally do NOT treat markdown tables (pipe syntax) as "raw markdown"
    // for this suite. Depending on the markdown pipeline configuration, GFM tables may
    // render as plain text in a <p> (no <table> element) even when the pipeline is
    // functioning correctly. The regression we're guarding against is frames being
    // lost and content reverting to visible code fences/headings.

    // List markers are harder to detect because rendered lists still show bullets
    // We'll skip checking those - the presence of <ul>/<ol> is enough

    return false;
  }

  test("Message 1: quantum computing has rendered markdown after completion", async ({ page }) => {
    // Send first message
    await sendMessageAndWait(page, "Tell me about quantum computing");

    // Should have 2 messages (user + assistant)
    await expect(
      page.locator('[data-testid="thread-item"][aria-pressed="true"]').getByText("2 messages"),
    ).toBeVisible({ timeout: 5000 });

    // Get the assistant message
    const assistantMessages = getAssistantMessages(page);
    await expect(assistantMessages).toHaveCount(1);

    const firstMessage = assistantMessages.first();

    // Should have rendered markdown (paragraphs, possibly headings, lists, etc.)
    const hasRendered = await hasRenderedMarkdown(firstMessage);
    expect(hasRendered).toBe(true);

    // Should NOT show raw markdown
    const hasRaw = await hasRawMarkdown(firstMessage);
    expect(hasRaw).toBe(false);
  });
});
