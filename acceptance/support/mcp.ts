import { call, resource } from "effection";
import { createMcpApp, type McpAppConfig } from "@sweatpants/agent-host/mcp";
import { serve, type ApplicationServer } from "@sweatpants/agent-host/node";
import { MCP_PROTOCOL_VERSION } from "@sweatpants/tool-session/mcp";
import { testToolRuntime } from "./test-tool-runtime.ts";

/** Real ingress and application lifetime; scenarios supply their authored tools. */
export function useMcpServer(tools: McpAppConfig["tools"]) {
  return resource<ApplicationServer>(function* (provide) {
    const app = createMcpApp({
      name: "public-mcp-acceptance",
      version: "1.0.0",
      secret: "public-mcp-continuation-secret-at-least-32-bytes",
      tools,
      execution: testToolRuntime(),
      *authenticate() {
        return "acceptance-client";
      },
    });
    const server = yield* call(() => serve(app, { port: 0 }));
    try {
      yield* provide(server);
    } finally {
      yield* call(() => server.close());
    }
  });
}

/** Wire serialization only: no continuation decisions or result normalization. */
export function* mcpRequest(
  origin: string,
  method: string,
  params: Record<string, unknown> = {},
  capabilities: Record<string, unknown> = { elicitation: { form: {} }, sampling: {} },
) {
  const response = yield* call(() =>
    fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "Mcp-Method": method,
        /* CONDITIONAL-SPREAD: Omit Mcp-Name when the method does not name a tool. */
        ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": capabilities,
          },
        },
      }),
    }),
  );
  const text = yield* call(() => response.text());
  const messages = response.headers.get("content-type")?.includes("text/event-stream")
    ? [...text.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]))
    : [JSON.parse(text)];
  return { response, body: messages.at(-1), messages };
}
