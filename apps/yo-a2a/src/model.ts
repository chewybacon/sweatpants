import { createPiAiModelProviderDriver, resolvePiAiModel } from "@sweatpants/model-provider-pi-ai";
import {
  type AssistantMessage,
  type Context,
  type PortableModelContextMessage,
  type PortableModelTool,
} from "@sweatpants/model-provider";
import {
  createChatModelEffectRegistration,
  type ChatMessageV1,
  type ChatModelSampleInputV2,
  type ChatModelSampleOutputV2,
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

function modelContext(request: ChatModelSampleInputV2): Context {
  return {
    systemPrompt: String(request.systemPrompt.value),
    messages: request.messages.flatMap(toProviderMessages),
    tools: request.tools.map(toProviderTool),
  };
}
function toProviderMessages(message: ChatMessageV1): PortableModelContextMessage[] {
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
          type: "toolCall",
          toolCall: {
            id: callId,
            type: "function",
            function: { name: providerToolName(target), arguments: {} },
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: callId,
      name: providerToolName(target),
      content: valueText(tool["result"] as Json),
      isError: false,
    },
  ];
}
function toProviderTool(value: Json): PortableModelTool {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Authored model tool inventory is invalid");
  }
  const inputSchema = value["inputSchema"];
  if (inputSchema === null || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    throw new Error("Authored model tool schema projection is invalid");
  }
  return {
    name: providerToolName(String(value["name"])),
    ...(typeof value["description"] === "string" ? { description: value["description"] } : {}),
    parameters: inputSchema,
  };
}
function modelOutput(assistant: AssistantMessage, pullId: string): ChatModelSampleOutputV2 {
  const text = assistant.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const calls = assistant.content
    .filter((block) => block.type === "toolCall")
    .map((block) => ({
      id: block.toolCall.id,
      target: authoredToolName(block.toolCall.function.name),
      input: block.toolCall.function.arguments,
    }));
  return {
    message: {
      id: assistant.responseId ?? `model-${pullId}`,
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
