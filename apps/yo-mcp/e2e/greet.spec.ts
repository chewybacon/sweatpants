import { enableInspectorConnection } from "./fixtures/inspector.ts";
import { test, expect, type Page } from "@playwright/test";

/**
 * E2E tests for the greet tool.
 *
 * The greet tool uses the sampling backchannel to generate a personalized greeting.
 * When the tool runs, it sends a sampling request to the client (Inspector),
 * which should display the request in the Sampling tab for the user to respond.
 */

// Helper to connect to server
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

async function callGreetViaMcpSampling(input: {
  name: string;
  style: "formal" | "casual" | "poetic" | "pirate";
  sampledGreeting: string;
}): Promise<Record<string, unknown>> {
  async function post(params: Record<string, unknown>) {
    const response = await fetch("http://localhost:3001/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "greet",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": { sampling: {} },
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.has("mcp-session-id")).toBe(false);
    const text = await response.text();
    const messages = [...text.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]));
    return messages.at(-1).result;
  }
  const params = { name: "greet", arguments: { name: input.name, style: input.style } };
  const pending = await post(params);
  expect(pending.resultType).toBe("input_required");
  const requestId = Object.keys(pending.inputRequests)[0];
  expect(pending.inputRequests[requestId].method).toBe("sampling/createMessage");
  expect(JSON.stringify(pending.inputRequests[requestId].params)).toContain(input.name);
  expect(JSON.stringify(pending.inputRequests[requestId].params)).toContain(input.style);
  const result = await post({
    ...params,
    requestState: pending.requestState,
    inputResponses: {
      [requestId]: {
        role: "assistant",
        content: { type: "text", text: input.sampledGreeting },
        model: "playwright-sampling-model",
        stopReason: "endTurn",
      },
    },
  });
  expect(result.resultType).toBe("complete");
  expect(result.isError).toBe(false);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

test.describe("Greet Tool (Sampling)", () => {
  test("generates greeting via sampling backchannel", async ({ page }) => {
    await page.goto("/");
    await connectToServer(page);

    // Capture console messages for debugging
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        console.log(`Browser ${msg.type()}: ${msg.text()}`);
      }
    });

    // Select the greet tool
    await selectTool(page, "greet");

    // The right panel should show the tool form
    const nameInput = page.getByRole("textbox", { name: "name" });
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await nameInput.fill("Alice");

    // Keep the default style selected by the Inspector form; the sampling
    // backchannel is what this test exercises, and combobox rendering has been
    // a source of Inspector-version-specific flake.

    // Execute the tool - this triggers the sampling request.
    await page.getByRole("button", { name: "Execute Tool", exact: true }).click();

    await expect(page.getByText("Sampling Request", { exact: true })).toBeVisible({
      timeout: 10000,
    });

    const responseInput = page.getByRole("textbox", { name: "Response", exact: true });
    await expect(responseInput).toBeVisible({ timeout: 10000 });
    await responseInput.fill(
      "Dear Alice, it is my pleasure to extend warm greetings to you on this fine day.",
    );

    await page.getByRole("button", { name: "Send Response", exact: true }).click();

    const resultText = await page.locator("body").textContent();
    expect(resultText).toContain('"name": "Alice"');
    expect(resultText).toContain('"style": "casual"');
    expect(resultText).toContain('"greeting": "Dear Alice, it is my pleasure');
    expect(resultText).not.toContain("Running...");
  });

  test("handles different greeting styles", async () => {
    for (const scenario of [
      {
        name: "Morgan",
        style: "casual" as const,
        sampledGreeting: "Hey Morgan! Hope your day is going great.",
      },
      {
        name: "Morgan",
        style: "poetic" as const,
        sampledGreeting: "Morgan, may your morning bloom like sunlight over quiet hills.",
      },
      {
        name: "Morgan",
        style: "pirate" as const,
        sampledGreeting: "Ahoy Morgan! May fair winds carry ye toward grand adventure.",
      },
    ]) {
      const result = await callGreetViaMcpSampling(scenario);
      expect(result).toMatchObject({
        name: scenario.name,
        style: scenario.style,
        greeting: scenario.sampledGreeting,
      });
    }
  });
});
