import type * as PiAi from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  UnsupportedModelCapabilityError,
  type Model,
  type ModelContext,
} from "@sweatpants/model-provider";
import { decodePiModelResponse, encodePiContext, encodePiToolChoice } from "../canonical.ts";

const model: Model = {
  id: "test-model",
  name: "Test model",
  api: "test",
  provider: "test",
  reasoning: false,
  input: ["text", "image"],
  contextWindow: 16_000,
  maxTokens: 1_000,
};

function piResponse(content: PiAi.AssistantMessage["content"]): PiAi.AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test-model",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

describe("Pi-AI canonical boundary codec", () => {
  it("encodes canonical completed tool history directly to SDK-owned values", () => {
    const context: ModelContext = {
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Look this up." },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCall: {
                id: "call-1",
                name: "lookup",
                input: { q: "Ada" },
                thoughtSignature: null,
              },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          name: "lookup",
          content: '{"answer":"Ada"}',
          isError: false,
        },
      ],
      tools: [],
    };

    const encoded = encodePiContext(context, model);
    expect(encoded.systemPrompt).toBe("Be concise.");
    expect(encoded.messages).toMatchObject([
      { role: "user", content: "Look this up." },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { q: "Ada" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "lookup",
        content: [{ type: "text", text: '{"answer":"Ada"}' }],
      },
    ]);
  });

  it("rejects an unpaired canonical tool call instead of silently projecting it away", () => {
    const context: ModelContext = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCall: { id: "call-1", name: "lookup", input: {}, thoughtSignature: null },
            },
          ],
        },
      ],
      tools: [],
    };

    expect(() => encodePiContext(context, model)).toThrow(
      expect.objectContaining({
        code: "unsupported-model-capability",
        modality: "unsettled-tool-call",
      }),
    );
  });

  it("maps required tool choice at provider API boundaries without a package patch", () => {
    expect(encodePiToolChoice({ ...model, api: "anthropic-messages" }, "required")).toBe("any");
    expect(encodePiToolChoice({ ...model, api: "bedrock-converse-stream" }, "required")).toBe(
      "any",
    );
    expect(encodePiToolChoice({ ...model, api: "google-generative-ai" }, "required")).toBe("any");
    expect(encodePiToolChoice({ ...model, api: "openai-responses" }, "required")).toBe("required");
  });

  it("decodes an SDK response through canonical Chat and Model owner decoders", () => {
    const response = decodePiModelResponse(
      piResponse([
        { type: "thinking", thinking: "Check the index.", thinkingSignature: "reasoning-sig" },
        {
          type: "toolCall",
          id: "call-1",
          name: "lookup",
          arguments: { q: "Ada" },
          thoughtSignature: "call-sig",
        },
      ]),
    );

    expect(response).toMatchObject({
      source: { api: "test", provider: "test", model: "test-model", responseModel: null },
      usage: { input: 1, output: 2, total: 3 },
      stopReason: "toolUse",
      message: {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Check the index.",
            format: null,
            signature: "reasoning-sig",
            redacted: false,
          },
          {
            type: "tool-call",
            toolCall: {
              id: "call-1",
              name: "lookup",
              input: { q: "Ada" },
              thoughtSignature: "call-sig",
            },
          },
        ],
      },
    });
    expect(Object.isFrozen(response.message)).toBe(true);
  });

  it("uses typed capability errors for unsupported canonical input", () => {
    const context: ModelContext = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "data", value: "YWJj", mimeType: "application/pdf" },
              metadata: null,
            },
          ],
        },
      ],
      tools: [],
    };

    expect(() => encodePiContext(context, model)).toThrow(UnsupportedModelCapabilityError);
  });
});
