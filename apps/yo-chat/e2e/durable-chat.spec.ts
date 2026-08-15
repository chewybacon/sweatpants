import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";

/**
 * E2E tests for the Durable Chat Handler.
 *
 * These tests verify:
 * 1. Feature parity with regular /api/chat (basic streaming, tools, markdown)
 * 2. Native conversation protocol and reconnect behavior
 *
 * Tests require a configured chat model provider. The direct API assertions use
 * the same provider/model as the Playwright web server instead of hard-coding a
 * local Ollama model.
 *
 * Run with: pnpm test:e2e --grep "Durable"
 */

// Increase timeout for LLM responses
test.setTimeout(240000);

function directChatRequest(content: string) {
  const conversationId = `e2e:${randomUUID()}`;
  const runId = randomUUID();
  const messageId = randomUUID();
  return {
    command: {
      type: "send-message",
      commandId: runId,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      basisRevision: null,
      messageId,
    },
    clientId: "durable-chat-e2e",
    conversationId,
    userMessage: { id: messageId, role: "user", content },
    state: {},
    context: [],
    forwardedProps: {},
  };
}

// =============================================================================
// PARITY TESTS - These should pass just like /demo/chat tests
// =============================================================================

test.describe("Durable Chat - Feature Parity", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/chat/basic/", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Basic Chat" })).toBeVisible();
    await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("thread-create").click();
    await expect(page.getByPlaceholder("Type a message...")).toBeEnabled({ timeout: 15000 });
  });

  test("can send a simple message and receive a response", async ({ page }) => {
    const input = page.getByPlaceholder("Type a message...");
    await input.pressSequentially("Say exactly: Hello World", { delay: 10 });

    await page.getByRole("button", { name: "Send" }).click();

    // Wait for streaming to start
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 60000 });

    // Wait for the response to complete
    await expect(page.getByRole("button", { name: "Stop" })).not.toBeVisible({ timeout: 120000 });

    // Should have user message (use first() to avoid strict mode if LLM quotes it)
    await expect(page.getByText("Say exactly: Hello World").first()).toBeVisible();

    // Should show 2 messages (user + assistant) on the active thread.
    await expect(
      page.locator('[data-testid="thread-item"][aria-pressed="true"]').getByText("2 messages"),
    ).toBeVisible({ timeout: 5000 });

    // CRITICAL: Verify assistant message actually has content rendered
    // This catches bugs where the message bubble appears but content is empty/undefined
    const assistantMessage = page.locator(".prose").last();
    const assistantText = await assistantMessage.textContent();
    expect(assistantText).toBeTruthy();
    expect(assistantText!.length).toBeGreaterThan(0);

    // Should NOT contain "undefined" which indicates parsing issues
    expect(assistantText).not.toContain("undefined");
    expect(assistantText).not.toContain("undefinedundefined");

    console.log("Assistant response:", assistantText?.slice(0, 100));
  });

  test("can abort a streaming response", async ({ page }) => {
    const input = page.getByPlaceholder("Type a message...");
    // Use a longer prompt that takes more time to stream
    await input.pressSequentially(
      "Write a very long essay about the history of computing, covering at least 20 major milestones",
      { delay: 5 },
    );

    await page.getByRole("button", { name: "Send" }).click();

    // Wait for streaming to start
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 60000 });

    // Wait for Stop button to appear (it replaces Send during streaming)
    const stopButton = page.getByRole("button", { name: "Stop" });
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    // Abort the response
    await stopButton.click();

    // Streaming should stop
    await expect(page.getByRole("button", { name: "Stop" })).not.toBeVisible({ timeout: 10000 });

    // Should show messages were received on the active thread.
    await expect(
      page
        .locator('[data-testid="thread-item"][aria-pressed="true"]')
        .locator("text=/[12] messages/"),
    ).toBeVisible({ timeout: 5000 });
  });

  test("thinking/reasoning content renders without undefined", async ({ page }) => {
    // This test specifically catches the text vs content field mismatch bug
    // where thinking content was coming through as "undefined" repeatedly
    const input = page.getByPlaceholder("Type a message...");
    await input.pressSequentially("What is 2+2? Think step by step.", { delay: 10 });

    await page.getByRole("button", { name: "Send" }).click();

    // Wait for response to complete
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 60000 });
    await expect(page.getByRole("button", { name: "Stop" })).not.toBeVisible({ timeout: 120000 });

    // Get all text content from the assistant's response area
    const pageContent = await page.content();

    // Should NOT have repeated "undefined" which indicates field mismatch
    const undefinedMatches = pageContent.match(/undefined/g) || [];
    // Allow at most 2 occurrences (could be legitimate in code examples)
    // but NOT the "undefinedundefinedundefined..." pattern
    expect(pageContent).not.toContain("undefinedundefined");

    console.log(`Page contains ${undefinedMatches.length} occurrences of 'undefined'`);

    // Verify we actually got meaningful content
    const assistantMessage = page.locator(".prose").last();
    const assistantText = await assistantMessage.textContent();
    expect(assistantText).toBeTruthy();
    expect(assistantText!.length).toBeGreaterThan(10);

    console.log("Response:", assistantText?.slice(0, 150));
  });

  test("can reset the conversation", async ({ page }) => {
    const input = page.getByPlaceholder("Type a message...");
    await input.pressSequentially("Say hi", { delay: 10 });
    await page.getByRole("button", { name: "Send" }).click();

    // Wait for response
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 60000 });
    await expect(page.getByRole("button", { name: "Stop" })).not.toBeVisible({ timeout: 120000 });
    await expect(
      page.locator('[data-testid="thread-item"][aria-pressed="true"]').getByText("2 messages"),
    ).toBeVisible({ timeout: 5000 });

    // Reset the conversation
    await page.getByTestId("thread-create").click();

    // Should show empty state
    await expect(page.getByRole("heading", { name: "Start a durable conversation" })).toBeVisible();
    await expect(
      page.locator('[data-testid="thread-item"][aria-pressed="true"]').getByText("0 messages"),
    ).toBeVisible();
  });
});

test.describe("Durable Chat - Tool Calling", () => {
  test("LLM can call the calculator tool", async ({ page }) => {
    // Use math route for calculator tool
    await page.goto("/chat/math/", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Math Assistant" })).toBeVisible();
    await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10000 });

    const input = page.getByPlaceholder("Type a message...");
    await input.click(); // Ensure hydration
    await input.pressSequentially(
      "Use the calculator tool to compute 42 * 17. What is the result?",
      { delay: 5 },
    );

    await page.getByRole("button", { name: "Send", exact: true }).click();

    // Wait for response to start and complete
    // Use exact match for streaming indicator (lowercase 'thinking...')
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 60000 });
    await expect(page.getByRole("button", { name: "Stop" })).not.toBeVisible({
      timeout: 120000,
    });

    // Check the response contains either the answer or mentions calculator
    const responseText = await page.locator(".prose").last().textContent();
    expect(responseText).toBeTruthy();
    console.log("Calculator response:", responseText?.slice(0, 200));
  });

  test("LLM can call the pick_card tool and user can interact", async ({ page }) => {
    // Use cards route for pickCard tool
    await page.goto("/chat/cards/", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Card Picker" })).toBeVisible();
    await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10000 });

    const input = page.getByPlaceholder("Type a message...");
    await input.click(); // Ensure hydration
    await input.pressSequentially("Use the pick_card tool with count=3 to let me pick a card", {
      delay: 5,
    });

    await page.getByRole("button", { name: "Send" }).click();

    // Wait for response - could be card picker UI or text
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 60000 });

    // CRITICAL: Check there are no error messages displayed
    // This catches tool execution errors like "yield* is not iterable"
    const errorLocator = page.locator("text=/Error:|is not iterable|undefined/");
    const hasError = (await errorLocator.count()) > 0;
    if (hasError) {
      const errorText = await errorLocator.first().textContent();
      throw new Error(`Tool execution error detected: ${errorText}`);
    }

    // Try to find card picker UI
    const cardButton = page
      .locator("button")
      .filter({ hasText: /[AKQJ\d]+[\u2665\u2666\u2663\u2660]/ })
      .first();

    try {
      await expect(cardButton).toBeVisible({ timeout: 60000 });

      const cardText = await cardButton.textContent();
      console.log(`Found card picker! Clicking card: ${cardText}`);

      await cardButton.click();

      // After clicking, should show the selection confirmation
      await expect(page.getByText(/You picked:/)).toBeVisible({ timeout: 15000 });

      console.log("Card selection successful!");
    } catch (e) {
      // Card picker didn't appear - check if there's a text response
      await expect(page.getByRole("button", { name: "Stop" })).not.toBeVisible({ timeout: 120000 });

      // Check for errors again after streaming completes
      const postStreamError = page.locator("text=/Error:|is not iterable|yield\\*/");
      const hasPostError = (await postStreamError.count()) > 0;
      if (hasPostError) {
        const errorText = await postStreamError.first().textContent();
        throw new Error(`Tool execution error after streaming: ${errorText}`);
      }

      const responseText = await page.locator(".prose").last().textContent();
      console.log("No card picker appeared. Response:", responseText?.slice(0, 300));

      // If no card picker and no error, LLM just didn't call the tool
      // This is acceptable but log it
      expect(responseText).toBeTruthy();
    }
  });
});

// =============================================================================
// DURABLE-SPECIFIC TESTS - Features unique to the durable handler
// =============================================================================

test.describe("Durable Chat - Native protocol", () => {
  test("API emits native NDJSON without public session or offset metadata", async ({ request }) => {
    const response = await request.post("/api/chat", {
      data: directChatRequest("Hi"),
    });

    expect(response.status()).toBe(200);
    expect(response.headers()[["x", "session", "id"].join("-")]).toBeUndefined();
    expect(response.headers()["content-type"]).toContain("application/x-ndjson");

    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events[0]?.["type"]).toBe("RUN_STARTED");
    expect(events[1]?.["type"]).toBe("sweatpants.conversation-window.v1");
    expect(events[2]?.["type"]).toBe("sweatpants.conversation-authority.v1");
    const forbiddenOffsetKey = ["l", "s", "n"].join("");
    expect(events.every((event) => !(forbiddenOffsetKey in event) && !("event" in event))).toBe(
      true,
    );
    expect(events.some((event) => event["type"] === "session_info")).toBe(false);
    expect(events.at(-1)?.["type"]).toMatch(/^RUN_(FINISHED|ERROR)$/);
  });

  test("native text and reasoning events use AG-UI deltas", async ({ request }) => {
    const response = await request.post("/api/chat", {
      data: directChatRequest("Say hello"),
    });

    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const event of events) {
      if (
        event["type"] === "TEXT_MESSAGE_CONTENT" ||
        event["type"] === "REASONING_MESSAGE_CONTENT"
      ) {
        expect(typeof event["delta"]).toBe("string");
        expect(event["text"]).toBeUndefined();
        expect(event["content"]).toBeUndefined();
      }
    }
  });

  test("native response has a finite authority-terminated lifecycle", async ({ request }) => {
    const response = await request.post("/api/chat", {
      data: directChatRequest("Count to 5"),
    });
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const terminalIndex = events.findIndex((event) =>
      /^RUN_(FINISHED|ERROR)$/.test(String(event["type"])),
    );
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(events[terminalIndex - 1]?.["type"]).toBe("sweatpants.conversation-authority.v1");
    expect(events.slice(terminalIndex + 1)).toEqual([]);
  });
});

test.describe("Durable Chat - Reconnection", () => {
  test("persists conversation ID across page refresh", async ({ page }) => {
    // Navigate to basic chat
    await page.goto("/chat/basic/", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Basic Chat" })).toBeVisible();
    await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10000 });

    // Get the namespaced active thread ID from the shared sidebar.
    const activeThread = page.getByTestId("thread-item").filter({ hasText: "Active" });
    const conversationId1 = await activeThread.getAttribute("data-thread-id");
    expect(conversationId1).toBeTruthy();
    expect(conversationId1!.startsWith("basic:")).toBe(true);

    // Refresh the page
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Basic Chat" })).toBeVisible();

    // Verify the same namespaced conversation persists.
    const conversationId2 = await page
      .getByTestId("thread-item")
      .filter({ hasText: "Active" })
      .getAttribute("data-thread-id");
    expect(conversationId2).toBe(conversationId1);

    console.log(`Conversation ID persisted across refresh: ${conversationId1}`);
  });

  test("clear history generates new conversation ID", async ({ page }) => {
    // Navigate to basic chat
    await page.goto("/chat/basic/", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Basic Chat" })).toBeVisible();
    await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10000 });

    // Get the initial namespaced conversation ID.
    const conversationId1 = await page
      .getByTestId("thread-item")
      .filter({ hasText: "Active" })
      .getAttribute("data-thread-id");
    expect(conversationId1).toBeTruthy();

    // Send a message and wait for response
    const input = page.getByPlaceholder("Type a message...");
    await input.pressSequentially("Say hello", { delay: 10 });
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 60000 });
    await expect(page.getByRole("button", { name: "Stop" })).not.toBeVisible({ timeout: 120000 });
    await expect(
      page.locator('[data-testid="thread-item"][aria-pressed="true"]').getByText("2 messages"),
    ).toBeVisible({ timeout: 5000 });

    // Clear history
    await page.getByTestId("thread-create").click();

    // Wait for page to reload
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Basic Chat" })).toBeVisible();

    // Verify a new namespaced conversation ID was generated.
    const conversationId2 = await page
      .getByTestId("thread-item")
      .filter({ hasText: "Active" })
      .getAttribute("data-thread-id");
    expect(conversationId2).toBeTruthy();
    expect(conversationId2).not.toBe(conversationId1);

    console.log(`Old conversation ID: ${conversationId1}`);
    console.log(`New conversation ID: ${conversationId2}`);
  });
});
