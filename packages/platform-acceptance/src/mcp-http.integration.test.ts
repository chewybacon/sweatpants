import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { call, run } from "effection";
import { describe, expect, it } from "vitest";
import type { RuntimeTool } from "@sweatpants/agent-sdk";
import { createMcpHandler } from "@sweatpants/tool-session/mcp";
import {
  createInMemoryToolSessionStore,
  createToolInvocationHost,
  createToolSessionRegistry,
} from "@sweatpants/tool-runtime-local";
import {
  ACCEPTANCE_TOOL_NAME,
  NESTED_SAMPLE_PROMPT_MARKER,
  TOOL_RESULT_MARKER,
  acceptanceBookingTool,
} from "./lib/acceptance-app.ts";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

function workerBootstrapUrl(): URL {
  const candidates = [
    resolve(process.cwd(), "src/fixtures/acceptance-tool-worker-bootstrap.mjs"),
    resolve(
      process.cwd(),
      "packages/platform-acceptance/src/fixtures/acceptance-tool-worker-bootstrap.mjs",
    ),
  ];
  const candidate = candidates.find(existsSync);
  if (!candidate) {
    throw new Error("Failed to resolve MCP acceptance worker bootstrap");
  }
  return pathToFileURL(candidate);
}

async function nextMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { text: string },
) {
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
      if (data) {
        return JSON.parse(data) as JsonRpcMessage;
      }
      continue;
    }
    const next = await reader.read();
    if (next.done) {
      throw new Error("MCP stream ended before a terminal result");
    }
    state.text += decoder.decode(next.value, { stream: true });
  }
}

function post(body: unknown, sessionId?: string): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("MCP Streamable HTTP worker integration", () => {
  it("routes elicitation and sampling responses back into one live tool session", async () => {
    const result = await run(function* () {
      const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {
        worker: { workerUrl: workerBootstrapUrl(), isDev: false },
      });
      const { handler, manager } = createMcpHandler({
        // Control and replayable event reading are separate dependencies now.
        // This host uses the same private session registry as the event reader.
        registry,
        host: createToolInvocationHost(registry),
        tools: new Map<string, RuntimeTool>([[ACCEPTANCE_TOOL_NAME, acceptanceBookingTool]]),
      });
      try {
        const response = yield* call(() =>
          handler(
            post({
              jsonrpc: "2.0",
              id: "mcp-call-1",
              method: "tools/call",
              params: {
                name: ACCEPTANCE_TOOL_NAME,
                arguments: { from: "NYC", destination: "LAX" },
              },
            }),
          ),
        );
        expect(response.status).toBe(200);
        const sessionId = response.headers.get("mcp-session-id");
        expect(sessionId).toBeTruthy();
        const reader = response.body!.getReader();
        const buffer = { text: "" };

        const flight = yield* call(() => nextMessage(reader, buffer));
        expect(flight.method).toBe("elicitation/create");
        expect(JSON.stringify(flight.params)).toContain("Select a flight");
        expect(
          (yield* call(() =>
            handler(
              post(
                {
                  jsonrpc: "2.0",
                  id: flight.id,
                  result: { action: "accept", content: { flightId: "FL001" } },
                },
                sessionId!,
              ),
            ),
          )).status,
        ).toBe(202);

        const seat = yield* call(() => nextMessage(reader, buffer));
        expect(seat.method).toBe("elicitation/create");
        expect(
          (yield* call(() =>
            handler(
              post(
                {
                  jsonrpc: "2.0",
                  id: seat.id,
                  result: { action: "accept", content: { row: 2, seat: "A" } },
                },
                sessionId!,
              ),
            ),
          )).status,
        ).toBe(202);

        const sample = yield* call(() => nextMessage(reader, buffer));
        expect(sample.method).toBe("sampling/createMessage");
        expect(JSON.stringify(sample.params)).toContain(NESTED_SAMPLE_PROMPT_MARKER);
        expect(
          (yield* call(() =>
            handler(
              post(
                {
                  jsonrpc: "2.0",
                  id: sample.id,
                  result: {
                    role: "assistant",
                    content: { type: "text", text: "MCP nested sample response" },
                    model: "mcp-acceptance-model",
                    stopReason: "endTurn",
                  },
                },
                sessionId!,
              ),
            ),
          )).status,
        ).toBe(202);

        const terminal = yield* call(() => nextMessage(reader, buffer));
        expect(terminal.id).toBe("mcp-call-1");
        yield* call(() => reader.cancel());
        return terminal.result;
      } finally {
        yield* manager.cleanup();
      }
    });

    expect(JSON.stringify(result)).toContain(TOOL_RESULT_MARKER);
    expect(JSON.stringify(result)).toContain("MCP nested sample response");
  });
});
