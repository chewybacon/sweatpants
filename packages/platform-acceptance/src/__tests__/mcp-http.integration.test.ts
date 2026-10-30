import { call, run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import {
  createMcpHandler,
  classifyMcpToolDurability,
  MCP_PROTOCOL_VERSION,
  type McpHttpHandler,
} from "@sweatpants/tool-session/mcp";
import { createDurableTool } from "@sweatpants/agent-sdk";
import { SqliteJournal } from "@sweatpants/primitive-journal/sqlite";
import { z } from "zod";
import {
  ACCEPTANCE_TOOL_NAME,
  NESTED_SAMPLE_PROMPT_MARKER,
  TOOL_RESULT_MARKER,
} from "../lib/acceptance-app.ts";

const booking = createDurableTool(ACCEPTANCE_TOOL_NAME, { version: "1" })
  .description("MCP booking continuation fixture")
  .parameters(z.object({ from: z.string(), destination: z.string() }))
  .effects({})
  .elicits({
    pickFlight: { response: z.object({ flightId: z.string() }) },
    pickSeat: { response: z.object({ row: z.number(), seat: z.string() }) },
  })
  .samples()
  .execute(function* (params, ctx) {
    const flight = yield* ctx.elicit("pickFlight", {
      message: `Select a flight from ${params.from} to ${params.destination}`,
    });
    if (flight.action !== "accept") {
      return { success: false };
    }
    const seat = yield* ctx.elicit("pickSeat", { message: "Select your seat" });
    if (seat.action !== "accept") {
      return { success: false };
    }
    const tip = yield* ctx.sample({
      prompt: `${NESTED_SAMPLE_PROMPT_MARKER} Give a brief travel tip for ${params.destination}`,
    });
    return {
      success: true,
      marker: TOOL_RESULT_MARKER,
      flight: flight.content.flightId,
      seat: `${seat.content.row}${seat.content.seat}`,
      travelTip: tip.text,
    };
  });

interface MrtResult {
  resultType: string;
  requestState: string;
  inputRequests: Record<string, { method: string; params: unknown }>;
  content?: unknown;
}

function* invoke(handler: McpHttpHandler, params: Record<string, unknown>): Operation<MrtResult> {
  const response = yield* call(() =>
    handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          "Mcp-Method": "tools/call",
          "Mcp-Name": ACCEPTANCE_TOOL_NAME,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
              "io.modelcontextprotocol/clientCapabilities": {
                elicitation: { form: {} },
                sampling: {},
              },
            },
          },
        }),
      }),
    ),
  );
  expect(response.status).toBe(200);
  expect(response.headers.has("mcp-session-id")).toBe(false);
  const text = yield* call(() => response.text());
  const messages = [...text.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]));
  expect(messages.every((message) => !(message.method && message.id))).toBe(true);
  return messages.at(-1).result;
}

describe("MCP primitive integration", () => {
  it("routes two elicitations and sampling through continuations into one journal invocation", async () => {
    // This asserts MCP wire envelopes directly. The chat scenario vocabulary does
    // not expose server/discover or input_required HTTP round trips.
    const result = await run(function* () {
      expect(classifyMcpToolDurability({})).toBe("opaque");
      const { handler } = yield* createMcpHandler({
        name: "acceptance",
        version: "1",
        secret: "acceptance-continuation-secret-at-least-32-bytes",
        tools: [booking],
        createJournal: (identity) => new SqliteJournal(":memory:", identity),
        *authenticate() {
          return "acceptance-user";
        },
      });
      const original = {
        name: ACCEPTANCE_TOOL_NAME,
        arguments: { from: "NYC", destination: "LAX" },
      };
      const flight = yield* invoke(handler, original);
      expect(flight.resultType).toBe("input_required");
      const flightId = Object.keys(flight.inputRequests)[0];
      expect(flight.inputRequests[flightId].method).toBe("elicitation/create");
      expect(JSON.stringify(flight.inputRequests[flightId].params)).toContain("Select a flight");
      const seat = yield* invoke(handler, {
        ...original,
        requestState: flight.requestState,
        inputResponses: { [flightId]: { action: "accept", content: { flightId: "FL001" } } },
      });
      expect(seat.resultType).toBe("input_required");
      const seatId = Object.keys(seat.inputRequests)[0];
      expect(seat.inputRequests[seatId].method).toBe("elicitation/create");
      const sample = yield* invoke(handler, {
        ...original,
        requestState: seat.requestState,
        inputResponses: { [seatId]: { action: "accept", content: { row: 2, seat: "A" } } },
      });
      expect(sample.resultType).toBe("input_required");
      const sampleId = Object.keys(sample.inputRequests)[0];
      expect(sample.inputRequests[sampleId].method).toBe("sampling/createMessage");
      expect(JSON.stringify(sample.inputRequests[sampleId].params)).toContain(
        NESTED_SAMPLE_PROMPT_MARKER,
      );
      const terminal = yield* invoke(handler, {
        ...original,
        requestState: sample.requestState,
        inputResponses: {
          [sampleId]: {
            role: "assistant",
            content: { type: "text", text: "MCP nested sample response" },
            model: "mcp-acceptance-model",
            stopReason: "endTurn",
          },
        },
      });
      expect(terminal.resultType).toBe("complete");
      return terminal;
    });
    expect(JSON.stringify(result)).toContain(TOOL_RESULT_MARKER);
    expect(JSON.stringify(result)).toContain("MCP nested sample response");
  });
});
