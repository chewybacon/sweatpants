/**
 * MCP Spec Alignment Tests
 *
 * Tests for the MCP 2026-07-28 spec alignment changes:
 * 1. __schema__ meta-tool encoding pattern
 * 2. SampleExchange message counts (2 for raw, 3 for structured)
 * 3. URL elicitation guard
 * 4. createRawSampleExchange / createStructuredSampleExchange helpers
 */
import { describe, it, expect } from "vitest";
import {
  SCHEMA_TOOL_NAME,
  createRawSampleExchange,
  createStructuredSampleExchange,
} from "@sweatpants/agent-sdk";
import { encodeSamplingRequest, encodeElicitationRequest } from "../protocol/message-encoder.ts";
import type { SampleRequestEvent, ElicitRequestEvent } from "../../contract.ts";

// =============================================================================
// __SCHEMA__ META-TOOL ENCODING
// =============================================================================

describe("__schema__ meta-tool encoding", () => {
  it("should transform schema into __schema__ tool", () => {
    const event: SampleRequestEvent = {
      type: "sample_request",
      lsn: 1,
      timestamp: Date.now(),
      sampleId: "sample_1",
      messages: [{ role: "user", content: "Pick a cell" }],
      schema: {
        type: "object",
        properties: {
          cell: { type: "number", minimum: 0, maximum: 8 },
        },
        required: ["cell"],
      },
    };

    const request = encodeSamplingRequest(event, "req_1");

    // Should have tools array with __schema__ first
    expect(request.params?.tools).toBeDefined();
    expect(request.params?.tools).toHaveLength(1);
    expect(request.params?.tools?.[0]?.name).toBe(SCHEMA_TOOL_NAME);
    expect(request.params?.tools?.[0]?.description).toBe(
      "Respond with structured data matching this schema.",
    );
    expect(request.params?.tools?.[0]?.inputSchema).toEqual(event.schema);

    // Should force tool choice to required
    expect(request.params?.toolChoice).toEqual({ mode: "required" });
  });

  it("should prepend __schema__ to existing tools", () => {
    const event: SampleRequestEvent = {
      type: "sample_request",
      lsn: 1,
      timestamp: Date.now(),
      sampleId: "sample_1",
      messages: [{ role: "user", content: "Pick a strategy" }],
      schema: { type: "object", properties: { choice: { type: "string" } } },
      tools: [
        { name: "offensive", description: null, parameters: { type: "object" } },
        { name: "defensive", description: null, parameters: { type: "object" } },
      ],
    };

    const request = encodeSamplingRequest(event, "req_1");

    // Should have __schema__ first, then existing tools
    expect(request.params?.tools).toHaveLength(3);
    expect(request.params?.tools?.[0]?.name).toBe(SCHEMA_TOOL_NAME);
    expect(request.params?.tools?.[1]?.name).toBe("offensive");
    expect(request.params?.tools?.[2]?.name).toBe("defensive");
  });

  it("should not add __schema__ when no schema provided", () => {
    const event: SampleRequestEvent = {
      type: "sample_request",
      lsn: 1,
      timestamp: Date.now(),
      sampleId: "sample_1",
      messages: [{ role: "user", content: "Hello" }],
    };

    const request = encodeSamplingRequest(event, "req_1");

    expect(request.params?.tools).toBeUndefined();
    expect(request.params?.toolChoice).toBeUndefined();
  });

  it("should pass through tools without schema", () => {
    const event: SampleRequestEvent = {
      type: "sample_request",
      lsn: 1,
      timestamp: Date.now(),
      sampleId: "sample_1",
      messages: [{ role: "user", content: "Pick" }],
      tools: [{ name: "pick", description: null, parameters: { type: "object" } }],
      toolChoice: "auto",
    };

    const request = encodeSamplingRequest(event, "req_1");

    expect(request.params?.tools).toHaveLength(1);
    expect(request.params?.tools?.[0]?.name).toBe("pick");
    expect(request.params?.toolChoice).toEqual({ mode: "auto" });
  });
});

// =============================================================================
// SAMPLE EXCHANGE HELPERS
// =============================================================================

describe("SampleExchange helpers", () => {
  describe("createRawSampleExchange", () => {
    it("should create 2-message exchange for raw sampling", () => {
      const exchange = createRawSampleExchange(
        "What is the weather?",
        "The weather is sunny and 72F.",
      );

      // Should have 2 messages
      expect(exchange.messages).toHaveLength(2);

      // Request should be user message
      expect(exchange.request.role).toBe("user");
      expect(exchange.request.content).toEqual([{ type: "text", text: "What is the weather?" }]);

      // Response should be assistant message
      expect(exchange.response.role).toBe("assistant");
      expect(exchange.response.content).toEqual([
        { type: "text", text: "The weather is sunny and 72F." },
      ]);

      // Messages should be [request, response]
      expect(exchange.messages[0]).toBe(exchange.request);
      expect(exchange.messages[1]).toBe(exchange.response);

      // Parsed should be undefined
      expect(exchange.parsed).toBeUndefined();
    });

    it("should handle empty strings", () => {
      const exchange = createRawSampleExchange("", "");

      expect(exchange.messages).toHaveLength(2);
      expect(exchange.request.content).toEqual([{ type: "text", text: "" }]);
      expect(exchange.response.content).toEqual([{ type: "text", text: "" }]);
    });
  });

  describe("createStructuredSampleExchange", () => {
    it("should create 3-message exchange for structured output", () => {
      const parsed = { cell: 4, reason: "center strategy" };
      const exchange = createStructuredSampleExchange("Pick a cell (0-8)", parsed, "call_abc123");

      // Should have 3 messages
      expect(exchange.messages).toHaveLength(3);

      // Request should be user message
      expect(exchange.request.role).toBe("user");
      expect(exchange.request.content).toEqual([{ type: "text", text: "Pick a cell (0-8)" }]);

      // Response should be assistant with a canonical tool-call part
      expect(exchange.response.role).toBe("assistant");
      expect(exchange.response.content).toEqual([
        {
          type: "tool-call",
          toolCall: {
            id: "call_abc123",
            name: "__schema__",
            input: {},
            thoughtSignature: null,
          },
        },
      ]);

      // Third message should be a canonical tool result with echoed parsed data
      const toolResult = exchange.messages[2];
      expect(toolResult?.role).toBe("tool");
      expect(toolResult?.content).toEqual([{ type: "text", text: JSON.stringify(parsed) }]);
      expect(toolResult).toMatchObject({
        toolCallId: "call_abc123",
        name: "__schema__",
        isError: false,
      });

      // Parsed should be the typed data
      expect(exchange.parsed).toEqual(parsed);
    });

    it("should preserve complex nested parsed data", () => {
      const parsed = {
        move: { cell: 4, confidence: 0.95 },
        alternatives: [{ cell: 0 }, { cell: 8 }],
      };
      const exchange = createStructuredSampleExchange("Analyze the board", parsed, "call_xyz");

      expect(exchange.parsed).toEqual(parsed);
      // The input in tool_use should be blank
      const toolUse = exchange.response.content[0];
      expect(toolUse).toMatchObject({ type: "tool-call" });
      if (toolUse?.type !== "tool-call") throw new Error("expected a tool-call part");
      expect(toolUse.toolCall.input).toEqual({});
    });

    it("should handle null parsed value", () => {
      const exchange = createStructuredSampleExchange("Try something", null, "call_null");

      expect(exchange.parsed).toBeNull();
      expect(exchange.messages).toHaveLength(3);

      const toolResult = exchange.messages[2];
      expect(toolResult?.role).toBe("tool");
      const toolResultContent = toolResult?.content;
      expect(toolResultContent).toEqual([{ type: "text", text: "null" }]);
    });
  });
});

// =============================================================================
// URL ELICITATION GUARD
// =============================================================================

describe("URL elicitation guard", () => {
  it("should throw error when mode is url", () => {
    const event = {
      type: "elicit_request" as const,
      lsn: 1,
      timestamp: Date.now(),
      elicitId: "elicit_1",
      key: "oauth",
      message: "Please authorize",
      schema: { type: "object" },
      mode: "url", // This is the problematic mode
    } as ElicitRequestEvent & { mode?: string };

    expect(() => encodeElicitationRequest(event, "req_1")).toThrow(
      "URL elicitation mode is not supported by sweatpants",
    );
  });

  it("should include helpful error message with spec link", () => {
    const event = {
      type: "elicit_request" as const,
      lsn: 1,
      timestamp: Date.now(),
      elicitId: "elicit_1",
      key: "oauth",
      message: "Please authorize",
      schema: { type: "object" },
      mode: "url",
    } as ElicitRequestEvent & { mode?: string };

    expect(() => encodeElicitationRequest(event, "req_1")).toThrow(
      /https:\/\/modelcontextprotocol\.io\/specification/,
    );
  });

  it("should work normally with form mode (explicit)", () => {
    const event = {
      type: "elicit_request" as const,
      lsn: 1,
      timestamp: Date.now(),
      elicitId: "elicit_1",
      key: "confirm",
      message: "Please confirm",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
      mode: "form",
    } as ElicitRequestEvent & { mode?: string };

    const request = encodeElicitationRequest(event, "req_1");

    expect(request.params?.mode).toBe("form");
    expect(request.params?.message).toBe("Please confirm");
  });

  it("should work normally without mode (defaults to form)", () => {
    const event: ElicitRequestEvent = {
      type: "elicit_request",
      lsn: 1,
      timestamp: Date.now(),
      elicitId: "elicit_1",
      key: "confirm",
      message: "Please confirm",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
    };

    const request = encodeElicitationRequest(event, "req_1");

    expect(request.params?.mode).toBe("form");
  });
});

// =============================================================================
// EXCHANGE MESSAGE COUNT CONSISTENCY
// =============================================================================

describe("Exchange message count consistency", () => {
  it("raw sample exchange always has exactly 2 messages", () => {
    const testCases = [
      { prompt: "Short", response: "Short reply" },
      { prompt: "A".repeat(1000), response: "B".repeat(2000) },
      { prompt: "", response: "" },
      { prompt: "With\nnewlines", response: "Also\nhas\nnewlines" },
    ];

    for (const { prompt, response } of testCases) {
      const exchange = createRawSampleExchange(prompt, response);
      expect(exchange.messages).toHaveLength(2);
      expect(exchange.messages[0]?.role).toBe("user");
      expect(exchange.messages[1]?.role).toBe("assistant");
    }
  });

  it("structured sample exchange always has exactly 3 messages", () => {
    const testCases = [
      { prompt: "Pick", parsed: { cell: 0 }, id: "call_1" },
      { prompt: "Complex", parsed: { a: { b: { c: 1 } } }, id: "call_2" },
      { prompt: "Array", parsed: [1, 2, 3], id: "call_3" },
      { prompt: "Null", parsed: null, id: "call_4" },
    ];

    for (const { prompt, parsed, id } of testCases) {
      const exchange = createStructuredSampleExchange(prompt, parsed, id);
      expect(exchange.messages).toHaveLength(3);
      expect(exchange.messages[0]?.role).toBe("user");
      expect(exchange.messages[1]?.role).toBe("assistant");
      expect(exchange.messages[2]?.role).toBe("tool");
    }
  });

  it("structured exchange tool_result references correct tool_use id", () => {
    const exchange = createStructuredSampleExchange(
      "Pick a move",
      { cell: 4 },
      "unique_call_id_123",
    );

    // Get tool_use id from response
    const toolUse = exchange.response.content[0];
    expect(toolUse).toMatchObject({ type: "tool-call" });
    if (toolUse?.type !== "tool-call") throw new Error("expected a tool-call part");
    expect(toolUse.toolCall.id).toBe("unique_call_id_123");

    // Get tool result call identity from third message
    const thirdMsg = exchange.messages[2];
    expect(thirdMsg?.role).toBe("tool");
    if (thirdMsg?.role !== "tool") throw new Error("expected a tool result");
    expect(thirdMsg.toolCallId).toBe("unique_call_id_123");

    // Tool result content should echo parsed data
    expect(thirdMsg.content).toEqual([{ type: "text", text: JSON.stringify({ cell: 4 }) }]);
  });
});
