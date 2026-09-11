import { describe, expect, it } from "vitest";
import { startYoMcpServer } from "../server.ts";

function rpc(id: string, method: string, params?: Record<string, unknown>) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

function ssePayloads(text: string): Array<Record<string, unknown>> {
  return [...text.matchAll(/^data:[ \t]*(.*)$/gm)]
    .map((match) => match[1]!.trim())
    .filter(Boolean)
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

async function nextSsePayload(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { text: string },
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  while (true) {
    const boundary = state.text.indexOf("\n\n");
    if (boundary >= 0) {
      const raw = state.text.slice(0, boundary);
      state.text = state.text.slice(boundary + 2);
      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (data) return JSON.parse(data) as Record<string, unknown>;
      continue;
    }
    const next = await reader.read();
    if (next.done) throw new Error("MCP stream ended before a JSON-RPC message");
    state.text += decoder.decode(next.value, { stream: true });
  }
}

describe("yo-mcp HTTP composition", () => {
  it("preserves the real elicitation response schema through the worker and HTTP wire", async () => {
    const server = await startYoMcpServer(0);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const called = await fetch(`${server.origin}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: rpc("pick-card-schema", "tools/call", {
          name: "pick_card",
          arguments: { count: 3 },
        }),
      });
      expect(called.status).toBe(200);
      const sessionId = called.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      reader = called.body!.getReader();
      const sseState = { text: "" };

      const request = await nextSsePayload(reader, sseState);
      expect(request["method"]).toBe("elicitation/create");
      expect(request["params"]).toMatchObject({ mode: "form" });
      expect(request["params"]).toMatchObject({
        requestedSchema: {
          type: "object",
          properties: {
            cardNumber: {
              type: "number",
              minimum: 1,
              description: "Card number (1-based)",
            },
          },
          required: ["cardNumber"],
        },
      });
      expect(request["params"]).toMatchObject({
        requestedSchema: {
          "x-elicit-context": { cards: expect.any(Array) },
        },
      });

      const response = await fetch(`${server.origin}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: request["id"],
          result: { action: "decline" },
        }),
      });
      expect(response.status).toBe(202);
      const terminal = await nextSsePayload(reader, sseState);
      expect(terminal["id"]).toBe("pick-card-schema");
      expect(terminal["result"]).toMatchObject({
        content: [{ text: expect.stringContaining('"success":false') }],
      });
    } finally {
      await reader?.cancel();
      await server.close();
    }
  });

  it("serves CORS, the app tool inventory, and a real worker-backed tool call", async () => {
    const server = await startYoMcpServer(0);
    try {
      const preflight = await fetch(`${server.origin}/mcp`, { method: "OPTIONS" });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

      const listed = await fetch(`${server.origin}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rpc("list-1", "tools/list"),
      });
      expect(listed.status).toBe(200);
      const listBody = (await listed.json()) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(listBody.result.tools.map((tool) => tool.name).sort()).toEqual([
        "confirm",
        "echo",
        "greet",
        "pick_card",
      ]);

      const called = await fetch(`${server.origin}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: rpc("echo-1", "tools/call", {
          name: "echo",
          arguments: { message: "landing smoke", uppercase: true },
        }),
      });
      expect(called.status).toBe(200);
      expect(called.headers.get("content-type")).toContain("text/event-stream");
      const payloads = ssePayloads(await called.text());
      const result = payloads.find((payload) => payload["id"] === "echo-1")?.["result"] as {
        content?: Array<{ text?: string }>;
      };
      expect(JSON.parse(result.content?.[0]?.text ?? "{}")).toEqual({
        echoed: "LANDING SMOKE",
        length: 13,
      });
    } finally {
      await server.close();
    }
  });
});
