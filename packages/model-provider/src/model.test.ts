import { describe, expect, it } from "vitest";
import {
  ModelDecodeError,
  decodeModelContext,
  decodeModelResponse,
  decodeModelStreamEvent,
} from "./model.ts";

describe("model operation contracts", () => {
  it("composes canonical Chat messages and definitions", () => {
    expect(
      decodeModelContext({
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: [{ type: "text", text: "hello" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "before" },
              {
                type: "tool-call",
                toolCall: { id: "call-1", name: "lookup", input: { q: "x" } },
              },
              { type: "reasoning", text: "because" },
              { type: "text", text: "after" },
            ],
          },
        ],
        tools: [{ name: "lookup", parameters: { type: "object" } }],
      }),
    ).toEqual({
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "before" },
            {
              type: "tool-call",
              toolCall: {
                id: "call-1",
                name: "lookup",
                input: { q: "x" },
                thoughtSignature: null,
              },
            },
            {
              type: "reasoning",
              text: "because",
              format: null,
              signature: null,
              redacted: false,
            },
            { type: "text", text: "after" },
          ],
        },
      ],
      tools: [{ name: "lookup", description: null, parameters: { type: "object" } }],
    });
  });

  it("normalizes response facts separately from ChatAssistantMessage", () => {
    expect(
      decodeModelResponse({
        message: { role: "assistant", content: [] },
      }),
    ).toEqual({
      message: { role: "assistant", content: [] },
      source: null,
      usage: null,
      stopReason: null,
      responseId: null,
      errorMessage: null,
    });

    expect(
      decodeModelResponse({
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        source: { api: "api", provider: "provider", model: "model" },
        usage: { input: 1, output: 2, total: 3 },
        stopReason: "stop",
        responseId: "response-1",
      }),
    ).toMatchObject({
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      source: { api: "api", provider: "provider", model: "model", responseModel: null },
      usage: { input: 1, output: 2, total: 3, cacheRead: null, cacheWrite: null, cost: null },
      stopReason: "stop",
      responseId: "response-1",
      errorMessage: null,
    });
  });

  it("rejects malformed contexts, response roles, and SDK-native values", () => {
    expect(() =>
      decodeModelContext({
        messages: [{ role: "developer", content: "allowed canonical role" }],
      }),
    ).not.toThrow();
    expect(() =>
      decodeModelContext({
        messages: [{ role: "reasoning", content: "not a message role" }],
      }),
    ).toThrow(ModelDecodeError);
    expect(() =>
      decodeModelContext({
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "lookup", parameters: new Date() }],
      }),
    ).toThrow(ModelDecodeError);
    expect(() => decodeModelResponse({ message: { role: "user", content: "hello" } })).toThrow(
      ModelDecodeError,
    );
  });

  it("decodes stream state variants and canonical settled calls", () => {
    expect(
      decodeModelStreamEvent({
        type: "tool-call-end",
        contentIndex: 0,
        toolCall: { id: "c", name: "lookup", input: {} },
        partial: { role: "assistant", content: [] },
      }),
    ).toMatchObject({
      type: "tool-call-end",
      toolCall: { id: "c", name: "lookup", input: {}, thoughtSignature: null },
    });
    expect(
      decodeModelStreamEvent({
        type: "reasoning-delta",
        contentIndex: 1,
        delta: "because",
        partial: { role: "assistant", content: [] },
      }),
    ).toMatchObject({ type: "reasoning-delta", delta: "because" });
    expect(() =>
      decodeModelStreamEvent({
        type: "error",
        reason: "other",
        error: { role: "assistant", content: [] },
      }),
    ).toThrow(ModelDecodeError);
  });
});
