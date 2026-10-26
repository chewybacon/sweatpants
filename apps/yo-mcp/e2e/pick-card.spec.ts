import { enableInspectorConnection } from "./fixtures/inspector.ts";
import { test, expect, type Page } from "@playwright/test";

/**
 * E2E tests for the pick_card tool.
 *
 * The pick_card tool uses the elicitation backchannel to let the user pick a card.
 * When the tool runs, it draws random cards and sends an elicitation request to the client,
 * which should display an inline form in the Inspector for the user to respond.
 */

// Helper to connect to server and open the Tools view.
async function connectToServer(page: Page) {
  await expect(page.getByRole("switch")).toBeVisible({ timeout: 10000 });
  await enableInspectorConnection(page);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 10000 });
  await page.locator('label[for$="-Tools"]').click();
}

// Helper to click on a tool in the list
async function selectTool(page: Page, toolName: string) {
  await page.getByRole("button", { name: toolName, exact: true }).click();
  await page.waitForTimeout(500);
}

test.describe("Pick Card Tool (Elicitation)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await connectToServer(page);
  });

  test("picks a card via elicitation backchannel", async ({ page }) => {
    // Capture console messages for debugging
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        console.log(`Browser ${msg.type()}: ${msg.text()}`);
      }
    });

    // Select the pick_card tool
    await selectTool(page, "pick_card");

    await page.screenshot({ path: "test-results/pick-card-01-selected.png", fullPage: true });

    // Set count to 3 for simpler testing
    const countInput = page.getByLabel(/count/i);
    if (await countInput.isVisible()) {
      await countInput.clear();
      await countInput.fill("3");
    }

    await page.screenshot({ path: "test-results/pick-card-02-filled.png", fullPage: true });

    // Execute the tool - this triggers the elicitation request.
    await page.getByRole("button", { name: "Execute Tool", exact: true }).click();

    // Wait for the elicitation request to be sent.
    await expect(page.getByText("Elicitation Request", { exact: true })).toBeVisible({
      timeout: 10000,
    });

    await page.screenshot({ path: "test-results/pick-card-03-after-run.png", fullPage: true });

    // The current Inspector renders the pending request inline rather than in a tab.
    await page.screenshot({
      path: "test-results/pick-card-04-elicitation-pending.png",
      fullPage: true,
    });

    // The elicitation message should contain the card options
    // Format: "1. <rank> of <suit>\n2. <rank> of <suit>\n3. <rank> of <suit>"
    const bodyText = (await page.locator("body").textContent()) ?? "";
    console.log("Body with inline elicitation form:", bodyText.slice(0, 2000));

    // Extract the first card from the message using regex
    // The message format is "1. X of Y" where X is rank (2-10, J, Q, K, A) and Y is suit
    const cardMatch = bodyText.match(/1\.\s*(\w+)\s+of\s+(\w+)/i);
    expect(cardMatch).toBeTruthy();

    const firstCardRank = cardMatch![1];
    const firstCardSuit = cardMatch![2];
    const firstCardDescription = `${firstCardRank} of ${firstCardSuit}`;
    console.log(`First card is: ${firstCardDescription}`);

    // Fill in the cardNumber field - pick card 1
    // The Inspector should render an input for cardNumber based on the JSON schema
    const cardNumberInput = page.locator('input[type="text"]').last();

    await expect(cardNumberInput).toBeVisible({ timeout: 5000 });
    await cardNumberInput.fill("1");

    await page.screenshot({
      path: "test-results/pick-card-06-response-filled.png",
      fullPage: true,
    });

    // Click Submit button to submit the elicitation response
    const submitButton = page.getByRole("button", { name: "Submit", exact: true });
    await expect(submitButton).toBeVisible();
    await submitButton.click();

    // Wait for the response to be processed
    await page.waitForTimeout(2000);

    await page.screenshot({ path: "test-results/pick-card-07-after-approve.png", fullPage: true });

    // The current Inspector keeps the result in the tool view.
    await page.screenshot({ path: "test-results/pick-card-08-final-result.png", fullPage: true });

    // Verify the result contains the picked card
    const finalBodyText = (await page.locator("body").textContent()) ?? "";
    console.log("Final body text:", finalBodyText.slice(0, 2000));

    // The result JSON contains:
    // - "picked": "<rank> of <suit>" matching our first card
    // - "success": true
    expect(finalBodyText).toContain('"success": true');
    expect(finalBodyText).toContain('"picked":');

    // Verify the picked card matches what we selected (card 1)
    expect(finalBodyText.toLowerCase()).toContain(firstCardDescription.toLowerCase());
  });

  test("handles declined elicitation", async ({ page }) => {
    // Capture console messages for debugging
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        console.log(`Browser ${msg.type()}: ${msg.text()}`);
      }
    });

    // Select the pick_card tool
    await selectTool(page, "pick_card");

    // Use default count (5)

    // Execute the tool.
    await page.getByRole("button", { name: "Execute Tool", exact: true }).click();

    // The current Inspector renders the pending request inline.
    await expect(page.getByText("Elicitation Request", { exact: true })).toBeVisible({
      timeout: 10000,
    });

    await page.screenshot({
      path: "test-results/pick-card-decline-01-elicitation-tab.png",
      fullPage: true,
    });

    // Click Decline button to decline the elicitation
    const declineButton = page.getByRole("button", { name: /decline/i }).first();
    await expect(declineButton).toBeVisible();
    await declineButton.click();

    await page.waitForTimeout(2000);

    await page.screenshot({
      path: "test-results/pick-card-decline-02-after-reject.png",
      fullPage: true,
    });

    // The current Inspector keeps the result in the tool view.
    await page.screenshot({
      path: "test-results/pick-card-decline-03-final-result.png",
      fullPage: true,
    });

    // The result should indicate no card was picked
    const finalBodyText = (await page.locator("body").textContent()) ?? "";
    console.log("Final body text after reject:", finalBodyText.slice(0, 2000));

    // Result should show success: false and "No card was picked"
    expect(finalBodyText).toContain('"success": false');
    expect(finalBodyText).toContain('"message": "No card was picked."');
  });
});
