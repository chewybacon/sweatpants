import { test, expect, type Page } from "@playwright/test";

/**
 * E2E tests for the echo tool.
 *
 * The echo tool is the simplest tool - no backchannel (sampling or elicitation).
 * It just echoes back the input message with optional uppercase transform.
 */

// Helper to connect to server and open the Tools view.
async function connectToServer(page: Page) {
  const serverSwitch = page.getByRole("switch");
  await expect(serverSwitch).toBeVisible({ timeout: 10000 });
  if (!(await serverSwitch.isChecked())) {
    await serverSwitch.click({ force: true });
  }
  await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 10000 });
  await page.locator('label[for$="-Tools"]').click();
}

// Helper to click on a tool in the list
async function selectTool(page: Page, toolName: string) {
  await page.getByRole("button", { name: toolName, exact: true }).click();
  await page.waitForTimeout(500);
}

test.describe("Echo Tool", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await connectToServer(page);
  });

  test("echoes back a simple message", async ({ page }) => {
    // Select the echo tool
    await selectTool(page, "echo");

    await page.screenshot({ path: "test-results/echo-01-selected.png", fullPage: true });

    // The right panel should show the tool form
    // Look for the message input field
    const messageInput = page.getByRole("textbox", { name: "message" });
    await expect(messageInput).toBeVisible({ timeout: 5000 });

    // Fill in the message
    await messageInput.fill("Hello, MCP!");

    await page.screenshot({ path: "test-results/echo-02-filled.png", fullPage: true });

    // Execute the tool.
    await page.getByRole("button", { name: "Execute Tool", exact: true }).click();

    // Wait for result to appear
    await page.waitForTimeout(2000);

    await page.screenshot({ path: "test-results/echo-03-result.png", fullPage: true });

    // Check that the result contains our echoed message
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).toContain("Hello, MCP!");
    expect(bodyText).toContain("echoed");
  });

  test("echoes back message in uppercase when flag is set", async ({ page }) => {
    // Select the echo tool
    await selectTool(page, "echo");

    // Fill in the message
    const messageInput = page.getByRole("textbox", { name: "message" });
    await expect(messageInput).toBeVisible({ timeout: 5000 });
    await messageInput.fill("hello world");

    // Find and check the uppercase checkbox
    const uppercaseCheckbox = page.getByRole("checkbox", { name: /uppercase/i });
    if (await uppercaseCheckbox.isVisible()) {
      await uppercaseCheckbox.check();
    } else {
      // Try to find a toggle/switch
      const uppercaseToggle = page.locator('[role="switch"]').filter({ hasText: /uppercase/i });
      if (await uppercaseToggle.isVisible()) {
        await uppercaseToggle.click();
      }
    }

    await page.screenshot({ path: "test-results/echo-uppercase-01-filled.png", fullPage: true });

    // Execute the tool.
    await page.getByRole("button", { name: "Execute Tool", exact: true }).click();

    await page.waitForTimeout(2000);

    await page.screenshot({ path: "test-results/echo-uppercase-02-result.png", fullPage: true });

    // Check that the result contains uppercase message
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).toContain("HELLO WORLD");
  });

  test("shows length in result", async ({ page }) => {
    // Select the echo tool
    await selectTool(page, "echo");

    // Fill in a known-length message
    const messageInput = page.getByRole("textbox", { name: "message" });
    await expect(messageInput).toBeVisible({ timeout: 5000 });
    await messageInput.fill("12345");

    // Execute the tool.
    await page.getByRole("button", { name: "Execute Tool", exact: true }).click();

    await page.waitForTimeout(2000);

    await page.screenshot({ path: "test-results/echo-length-result.png", fullPage: true });

    // Check that length is shown (should be 5)
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).toContain("12345");
    expect(bodyText).toContain("5"); // length
  });
});
