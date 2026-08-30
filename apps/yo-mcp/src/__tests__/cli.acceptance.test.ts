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

describe("yo-mcp HTTP composition", () => {
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
