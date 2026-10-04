import { call, run } from "effection";
import { describe, it, expect } from "vitest";
import { createTool } from "@sweatpants/agent-sdk";
import { z } from "zod";
import { ToolInvocationHostPort, ToolInvocationEventSourcePort } from "../../../invocation.ts";
import type { ToolSessionEvent } from "../../../contract.ts";
import { createMcpHandler } from "../mcp-handler.ts";

const tool = createTool("test")
  .description("test")
  .parameters(z.object({}))
  .execute(function* () {
    return {};
  });
const request = () =>
  new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "test",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "test",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/logLevel": "info",
        },
      },
    }),
  });

describe("request-scoped MCP streaming", () => {
  it("pulls one notification per demand and disposes on cancellation", async () => {
    await run(function* () {
      let reads = 0;
      let disposed = 0;
      yield* ToolInvocationHostPort.installDriver({
        *start() {},
        *turn() {
          return { type: "completed", result: {} };
        },
        *dispose() {
          disposed++;
        },
      });
      yield* ToolInvocationEventSourcePort.installDriver({
        *open() {
          return {
            *events(after = 0) {
              return {
                *next() {
                  reads++;
                  return {
                    done: false as const,
                    value: {
                      type: "log",
                      lsn: after + 1,
                      timestamp: 1,
                      level: "info",
                      message: "one",
                    } as ToolSessionEvent,
                  };
                },
              };
            },
          };
        },
      });
      const { handler } = yield* createMcpHandler({
        name: "test",
        version: "1",
        secret: "test-continuation-secret-at-least-32-bytes",
        tools: [tool],
        *authenticate() {
          return "user";
        },
      });
      const response = yield* call(() => handler(request()));
      expect(reads).toBe(0);
      const reader = response.body!.getReader();
      const first = yield* call(() => reader.read());
      expect(new TextDecoder().decode(first.value)).toContain("notifications/message");
      expect(reads).toBe(1);
      yield* call(() => reader.cancel());
      expect(disposed).toBe(1);
      expect(reads).toBe(1);
    });
  });
});
