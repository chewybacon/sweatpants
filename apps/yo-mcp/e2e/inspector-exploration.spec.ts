import { enableInspectorConnection } from "./fixtures/inspector.ts";
import { writeFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

/**
 * Exploration tests to understand the MCP Inspector UI structure.
 *
 * Run with: pnpm test:headed
 */

// Helper to connect to server and open the Tools view.
async function connectToServer(page: Page) {
  await expect(page.getByRole("switch")).toBeVisible({ timeout: 10000 });
  await enableInspectorConnection(page);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 10000 });
  await page.locator('label[for$="-Tools"]').click();
}

test.describe("MCP Inspector UI Exploration", () => {
  test("connect and list tools", async ({ page }) => {
    await page.goto("/");

    await page.screenshot({ path: "test-results/01-initial-load.png", fullPage: true });

    // Connect to server
    await connectToServer(page);

    await page.screenshot({ path: "test-results/02-after-connect.png", fullPage: true });

    // Check connection status
    const bodyText = await page.locator("body").textContent();
    console.log("Body after connect:", bodyText?.slice(0, 1000));

    const isConnected =
      bodyText?.includes("Connected") || bodyText?.includes("mcp-durable-runtime");
    console.log("Is connected:", isConnected);

    if (!isConnected) {
      console.log("Connection failed, checking for errors...");
      await page.screenshot({ path: "test-results/02b-connection-failed.png", fullPage: true });
      return;
    }

    // Tools are listed as part of the connection handshake.
    await page.screenshot({ path: "test-results/03-after-list-tools.png", fullPage: true });

    // Check for tools
    const bodyTextAfter = await page.locator("body").textContent();
    console.log("Body after list tools:", bodyTextAfter?.slice(0, 1500));

    const hasEcho = bodyTextAfter?.includes("echo");
    const hasGreet = bodyTextAfter?.includes("greet");
    const hasPickCard = bodyTextAfter?.includes("pick_card");

    console.log("Has echo tool:", hasEcho);
    console.log("Has greet tool:", hasGreet);
    console.log("Has pick_card tool:", hasPickCard);

    // If tools are listed, try clicking on one
    if (hasEcho) {
      console.log("Found echo tool, looking for it in the UI...");
      const echoInList = page.getByRole("button", { name: "echo", exact: true });
      if (await echoInList.isVisible()) {
        await echoInList.click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: "test-results/04-echo-selected.png", fullPage: true });
      }
    }
  });

  test("explore tool detail view", async ({ page }) => {
    await page.goto("/");

    // Connect to server; tools load as part of the connection handshake.
    await connectToServer(page);

    // Look for tools in the sidebar/list
    const toolsInBody = await page.locator("body").textContent();
    console.log("Tools visible:", toolsInBody?.includes("echo"), toolsInBody?.includes("greet"));

    await page.screenshot({ path: "test-results/05-tools-loaded.png", fullPage: true });

    // Try to find tool items - they might be in a list
    const toolItems = await page.locator('[class*="tool"], [data-tool]').all();
    console.log("Tool items found:", toolItems.length);

    // Look for buttons that might be tool entries
    const buttons = await page.getByRole("button").all();
    for (const btn of buttons.slice(0, 15)) {
      const text = await btn.textContent();
      if (text?.includes("echo") || text?.includes("greet") || text?.includes("pick")) {
        console.log("Found tool button:", text);
      }
    }
  });

  test("dump DOM structure after connection", async ({ page }) => {
    await page.goto("/");

    // Connect; tools load as part of the connection handshake.
    await connectToServer(page);

    // Get DOM structure
    const html = await page.locator("body").innerHTML();

    writeFileSync("test-results/dom-structure.html", html);
    console.log("DOM structure written to test-results/dom-structure.html");

    await page.screenshot({ path: "test-results/06-full-connected.png", fullPage: true });
  });
});
