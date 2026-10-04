import { describe, expect, it } from "vitest";
import type { ToolInvocationElicitAsk, ToolInvocationSampleAsk } from "../../../invocation.ts";
import { projectInputRequest, resumeInput } from "../interactions.ts";

const elicit: ToolInvocationElicitAsk = {
  kind: "elicit",
  requestId: "input-1",
  key: "card",
  message: "Choose a card",
  schema: {
    type: "object",
    properties: { card: { type: "object", properties: { rank: { type: "string" } } } },
  },
  binding: { id: "test-card-binding" },
};

describe("MCP interaction projection", () => {
  it("keeps nested authored responses behind an explicit flat form adapter", () => {
    const forms = {
      card: {
        present() {
          return {
            message: "Pick a card",
            requestedSchema: {
              type: "object",
              properties: { rank: { type: "string", enum: ["A", "K"] } },
              required: ["rank"],
            },
          };
        },
        accept(content: Record<string, unknown>) {
          return { card: { rank: String(content.rank) } };
        },
      },
    };
    expect(projectInputRequest(elicit, forms)).toMatchObject({
      method: "elicitation/create",
      params: { mode: "form", requestedSchema: { properties: { rank: { enum: ["A", "K"] } } } },
    });
    expect(
      resumeInput(elicit, { "input-1": { action: "accept", content: { rank: "A" } } }, forms),
    ).toMatchObject({
      kind: "elicit",
      response: { action: "accept", content: { card: { rank: "A" } } },
    });
    expect(() => projectInputRequest(elicit)).toThrow("flat MCP form adapter");
  });
  it("does not apply an accept mapping to decline or cancel", () => {
    for (const action of ["decline", "cancel"])
      expect(resumeInput(elicit, { "input-1": { action } })).toMatchObject({
        response: { action },
      });
  });
  it("retains sampling tool calls for agent-like authored tools", () => {
    const ask: ToolInvocationSampleAsk = { kind: "sample", requestId: "sample-1", messages: [] };
    const result = resumeInput(ask, {
      "sample-1": {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { city: "Boston" } }],
        model: "test",
        stopReason: "toolUse",
      },
    });
    expect(result).toMatchObject({
      kind: "sample",
      response: { stopReason: "toolUse", toolCalls: [{ id: "call-1", name: "lookup" }] },
    });
  });
  it("rejects wrong input keys and malformed sampling replies", () => {
    const ask: ToolInvocationSampleAsk = { kind: "sample", requestId: "sample-1", messages: [] };
    expect(() => resumeInput(ask, { other: {} })).toThrow("pending sampling response");
    expect(() => resumeInput(ask, { "sample-1": { role: "user" } })).toThrow(
      "Invalid sampling response",
    );
  });
});
