import { describe, expect, it } from "vitest";
import { call, run } from "effection";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import { MCP_PROTOCOL_VERSION } from "../../protocol-version.ts";
import type { ToolInvocationEventSource } from "../../../contract.ts";
import {
  ToolInvocationEventSourcePort,
  ToolInvocationHostPort,
  type ToolInvocationHost,
} from "../../../invocation.ts";
import { createMcpHandler, generateMcpManifest } from "../mcp-handler.ts";

const unusedEvents = {} as ToolInvocationEventSource;
const unusedHost = {} as ToolInvocationHost;

function handle(request: Request): Promise<Response> {
  return run(function* () {
    yield* ToolInvocationHostPort.installDriver(unusedHost);
    yield* ToolInvocationEventSourcePort.installDriver(unusedEvents);
    const { handler } = yield* createMcpHandler({ tools: new Map() });
    return yield* call(() => handler(request));
  });
}

function initialize(protocolVersion?: string): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: {
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        capabilities: { elicitation: {}, sampling: {} },
        clientInfo: { name: "test", version: "1" },
      },
    }),
  });
}

function ping(protocolVersion: string): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "ping-1", method: "ping" }),
  });
}

describe("canonical MCP profile", () => {
  it("negotiates MCP 2025-11-25 without advertising unimplemented extensions", async () => {
    const response = await handle(initialize(MCP_PROTOCOL_VERSION));
    const body = (await response.json()) as {
      result: { protocolVersion: string; capabilities: Record<string, unknown> };
    };
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(body.result.capabilities).not.toHaveProperty("experimental");
  });

  it("returns its supported version when the client proposes an older version", async () => {
    const response = await handle(initialize("2024-11-05"));
    const body = (await response.json()) as { result: { protocolVersion: string } };
    expect(response.status).toBe(200);
    expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it("returns a correlated invalid-params error when protocolVersion is missing", async () => {
    const response = await handle(initialize());
    const body = (await response.json()) as {
      id: string;
      error: { code: number; message: string };
    };
    expect(response.status).toBe(400);
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: "initialize-1",
      error: { code: -32602, message: "initialize requires params.protocolVersion" },
    });
  });

  it("rejects a conflicting post-initialize MCP-Protocol-Version header", async () => {
    const response = await handle(ping("2024-11-05"));
    const body = (await response.json()) as { id: string; error: { code: number } };
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ id: "ping-1", error: { code: -32602 } });
  });

  it("keeps authored x-sweatpants metadata consumable by CLI clients", () => {
    const interactive = createTool("interactive")
      .description("interactive tool")
      .parameters(z.object({}))
      .elicits({ approval: z.boolean() })
      .execute(function* () {
        return { ok: true };
      });
    const manifest = generateMcpManifest(new Map([["interactive", interactive]]));
    expect(manifest.tools[0]?._meta?.["x-sweatpants"]?.requires).toEqual({
      elicitation: true,
    });
  });
});
