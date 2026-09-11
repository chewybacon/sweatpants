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

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
};

type SseReader = ReadableStreamDefaultReader<Uint8Array>;

type SseBuffer = { text: string };

function parseSseData(rawEvent: string): string | null {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  return data.trim().length > 0 ? data : null;
}

async function readNextSseMessage(reader: SseReader, buffer: SseBuffer): Promise<JsonRpcMessage> {
  const decoder = new TextDecoder();

  while (true) {
    const boundary = buffer.text.indexOf("\n\n");
    if (boundary >= 0) {
      const rawEvent = buffer.text.slice(0, boundary);
      buffer.text = buffer.text.slice(boundary + 2);
      const data = parseSseData(rawEvent);
      if (!data) {
        continue;
      }
      return JSON.parse(data) as JsonRpcMessage;
    }

    const next = await reader.read();
    if (next.done) {
      throw new Error("SSE stream ended before the expected message arrived");
    }
    buffer.text += decoder.decode(next.value, { stream: true });
  }
}

async function readUntilSseMessage(
  reader: SseReader,
  buffer: SseBuffer,
  label: string,
  predicate: (message: JsonRpcMessage) => boolean,
): Promise<JsonRpcMessage> {
  const readLoop = async () => {
    while (true) {
      const message = await readNextSseMessage(reader, buffer);
      if (predicate(message)) {
        return message;
      }
    }
  };

  return Promise.race([
    readLoop(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 15000);
    }),
  ]);
}

async function callGreetViaMcpSampling(input: {
  name: string;
  style: "formal" | "casual" | "poetic" | "pirate";
  sampledGreeting: string;
}): Promise<Record<string, unknown>> {
  const callId = `call-${input.style}-${Date.now()}`;
  const response = await fetch("http://localhost:3001/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: callId,
      method: "tools/call",
      params: {
        name: "greet",
        arguments: {
          name: input.name,
          style: input.style,
        },
      },
    }),
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const sessionId =
    response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id");
  expect(sessionId).toBeTruthy();
  expect(response.body).toBeTruthy();

  const reader = response.body!.getReader();
  const buffer = { text: "" };

  try {
    const sampleRequest = await readUntilSseMessage(
      reader,
      buffer,
      "sampling/createMessage request",
      (message) => message.method === "sampling/createMessage",
    );
    expect(sampleRequest.id).toBeTruthy();
    expect(JSON.stringify(sampleRequest.params)).toContain(input.name);
    expect(JSON.stringify(sampleRequest.params)).toContain(input.style);

    const sampleResponse = await fetch("http://localhost:3001/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: sampleRequest.id,
        result: {
          role: "assistant",
          content: { type: "text", text: input.sampledGreeting },
          model: "playwright-sampling-model",
          stopReason: "endTurn",
        },
      }),
    });

    expect(sampleResponse.status).toBe(202);

    const toolResult = await readUntilSseMessage(
      reader,
      buffer,
      "tools/call result",
      (message) => message.id === callId && !!message.result,
    );

    const result = toolResult.result as { content?: Array<{ text?: unknown }>; isError?: boolean };
    expect(result.isError).toBe(false);
    const resultText = result.content?.[0]?.text;
    expect(typeof resultText).toBe("string");
    return JSON.parse(resultText as string) as Record<string, unknown>;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
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
