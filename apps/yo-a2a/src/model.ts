import { createPiAiModelProviderDriver, resolvePiAiModel } from "@sweatpants/model-provider-pi-ai";
import type { ModelContext, ModelResponse } from "@sweatpants/model-provider";
import type { ChatMessage, ChatToolDefinition } from "@sweatpants/chat-contract";
import {
  createChatModelEffectRegistration,
  type AuthoredChatMessage,
  type AuthoredChatModelSampleRequest,
  type AuthoredChatModelSampleResult,
} from "@sweatpants/chat-core";
import { canonicalJson, type Json } from "@sweatpants/foundation";

const selection = {
  provider: process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? "github-copilot",
  id: process.env["DEFAULT_CHAT_MODEL_ID"] ?? "gpt-5.5",
};
const model = resolvePiAiModel(selection);
const driver = createPiAiModelProviderDriver();

/** Real deployment binding for the authored chat program's model.sample effect. */
export const realModelRegistration = createChatModelEffectRegistration({
  allowedClassifications: ["public", "internal"],
  *sample(request, effect) {
    const sampling =
      request.sampling && typeof request.sampling === "object" && !Array.isArray(request.sampling)
        ? request.sampling
        : {};
    const assistant = yield* driver.sample({
      model,
      context: modelContext(request),
      options: {
        signal: effect.cancellation,
        sessionId: effect.pullId,
        toolChoice:
          sampling["toolChoice"] === "required"
            ? "required"
            : sampling["toolChoice"] === "none"
              ? "none"
              : "auto",
        ...(typeof sampling["maxTokens"] === "number" ? { maxTokens: sampling["maxTokens"] } : {}),
      },
    });
    if (process.env["YO_A2A_DEBUG_MODEL"] === "1") {
      console.error("[yo-a2a:model]", JSON.stringify(assistant));
    }
    if (assistant.stopReason === "error" || assistant.errorMessage) {
      throw new Error("Configured model provider failed to sample");
    }
    return modelOutput(assistant, effect.pullId);
  },
});

export const selectedModel = Object.freeze(selection);

function modelContext(request: AuthoredChatModelSampleRequest): ModelContext {
  return {
    messages: [
      { role: "system", content: String(request.systemPrompt.value) },
      ...request.messages.flatMap(toChatMessages),
    ],
    tools: request.tools.map(toProviderTool),
  };
}
function toChatMessages(message: AuthoredChatMessage): ChatMessage[] {
  const text = message.parts.map((part) => valueText(part.value)).join("\n");
  if (message.role === "user") {
    return [{ role: "user", content: text }];
  }
  if (message.role === "system") {
    return [{ role: "system", content: text }];
  }
  if (message.role === "assistant") {
    return [{ role: "assistant", content: [{ type: "text", text: text || "Continuing." }] }];
  }
  const tool = message.parts[0]?.value;
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    throw new Error(`Tool history message "${message.id}" has no correlation payload`);
  }
  const callId = tool["callId"];
  const target = tool["target"];
  if (typeof callId !== "string" || typeof target !== "string") {
    throw new Error(`Tool history message "${message.id}" has incomplete call identity`);
  }
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCall: {
            id: callId,
            name: providerToolName(target),
            input: {},
            thoughtSignature: null,
          },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: callId,
      name: providerToolName(target),
      content: valueText(tool["result"] as Json),
      isError: false,
    },
  ];
}
function toProviderTool(value: Json): ChatToolDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Authored model tool inventory is invalid");
  }
  const inputSchema = value["inputSchema"];
  if (inputSchema === null || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    throw new Error("Authored model tool schema projection is invalid");
  }
  return {
    name: providerToolName(String(value["name"])),
    description: typeof value["description"] === "string" ? value["description"] : null,
    parameters: inputSchema,
  };
}
function modelOutput(response: ModelResponse, pullId: string): AuthoredChatModelSampleResult {
  const text = response.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const calls = response.message.content
    .filter((part) => part.type === "tool-call")
    .map((part) => ({
      id: part.toolCall.id,
      target: authoredToolName(part.toolCall.name),
      input: part.toolCall.input,
    }));
  return {
    message: {
      id: response.responseId ?? `model-${pullId}`,
      role: "assistant",
      parts: [
        {
          value:
            text ||
            (calls.length > 0 ? `Calling ${calls.map((call) => call.target).join(", ")}` : "Done."),
          provenance: { classifications: [], sourceDigests: [] },
        },
      ],
    },
    calls,
    artifacts: [],
  };
}
function providerToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function authoredToolName(value: string): string {
  return value.startsWith("resources_") ? value.replace(/^resources_/, "resources.") : value;
}
function valueText(value: Json): string {
  return typeof value === "string" ? value : canonicalJson(value);
}
