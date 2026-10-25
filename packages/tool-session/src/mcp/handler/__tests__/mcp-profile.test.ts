import { describe, expect, it } from "vitest";
import { call, run } from "effection";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import { createMcpHandler } from "../mcp-handler.ts";
import { generateMcpManifest } from "../manifest.ts";

const version = "2026-07-28";
function request(method = "server/discover", headers: Record<string, string> = {}, params = {}) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": version,
      "Mcp-Method": method,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "test",
      method,
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": version,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
        ...params,
      },
    }),
  });
}
function handle(request: Request) {
  return run(function* () {
    const { handler } = yield* createMcpHandler({
      name: "test",
      version: "1",
      secret: "test-continuation-secret-at-least-32-bytes",
      tools: [],
      createJournal() {
        throw new Error("No invocation in profile checks");
      },
      *authenticate() {
        return "test-user";
      },
    });
    return yield* call(() => handler(request));
  });
}
describe("MCP 2026-07-28 profile", () => {
  it("discovers without initialize and advertises only tools", async () => {
    const response = await handle(request());
    expect(response.status).toBe(200);
    expect(response.headers.has("mcp-session-id")).toBe(false);
    expect(await response.json()).toMatchObject({
      id: "test",
      result: {
        resultType: "complete",
        supportedVersions: [version],
        capabilities: { tools: {} },
        ttlMs: 0,
        cacheScope: "private",
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "test", version: "1" } },
      },
    });
  });
  it.each(["initialize", "ping", "subscriptions/listen"])(
    "rejects unsupported %s instead of silently falling back",
    async (method) => {
      const response = await handle(request(method));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ id: "test", error: { code: -32601 } });
    },
  );
  it.each(["GET", "DELETE"])("rejects removed %s transport behavior", async (method) => {
    expect((await handle(new Request("http://localhost/mcp", { method }))).status).toBe(405);
  });
  it("rejects a foreign origin", async () => {
    expect(
      (await handle(request("server/discover", { origin: "https://untrusted.example" }))).status,
    ).toBe(403);
  });
  it("rejects unsupported versions with supported versions", async () => {
    const response = await handle(
      request(
        "server/discover",
        { "MCP-Protocol-Version": "2025-11-25" },
        {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2025-11-25",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: -32022, data: { supported: [version] } },
    });
  });
  it("rejects mismatched headers before execution", async () => {
    const response = await handle(request("server/discover", { "Mcp-Method": "tools/call" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32020 } });
  });
  it("requires both response media types", async () => {
    expect((await handle(request("server/discover", { accept: "application/json" }))).status).toBe(
      406,
    );
  });
  it("keeps authored schemas in the CLI manifest", () => {
    const tool = createTool("interactive")
      .description("interactive")
      .parameters(z.object({}))
      .elicits({ approval: z.boolean() })
      .execute(function* () {
        return { ok: true };
      });
    const manifest = generateMcpManifest(new Map([[tool.name, tool]]));
    expect(manifest.mcp.protocolVersion).toBe(version);
    expect(manifest.tools[0]._meta?.["x-sweatpants"]?.requires).toEqual({ elicitation: true });
  });
});
