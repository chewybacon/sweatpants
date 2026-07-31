import type { AssistantMessage, ModelResponseSource, ToolCall } from "./types.ts";
import type {
  PortableAssistantMessage,
  PortableModelAssistantBlock,
  PortableModelResponseSource,
  PortableToolCall,
} from "./portable.ts";

function portableToolCall(call: ToolCall): PortableToolCall {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.function.name,
      arguments: call.function.arguments,
    },
    ...(call.thoughtSignature !== undefined ? { thoughtSignature: call.thoughtSignature } : {}),
  };
}

function portableSource(source: ModelResponseSource): PortableModelResponseSource {
  return {
    api: source.api,
    provider: source.provider,
    model: source.model,
    ...(source.responseModel !== undefined ? { responseModel: source.responseModel } : {}),
  };
}

/** Projects exactly the provider-owned settled fields that are safe to journal. */
export function toPortableAssistantMessage(message: AssistantMessage): PortableAssistantMessage {
  return {
    role: "assistant",
    content: message.content.map((block): PortableModelAssistantBlock => {
      switch (block.type) {
        case "text":
          return {
            type: "text",
            text: block.text,
            ...(block.textSignature !== undefined ? { textSignature: block.textSignature } : {}),
          };
        case "thinking":
          return {
            type: "thinking",
            text: block.text,
            ...(block.format !== undefined ? { format: block.format } : {}),
            ...(block.thinkingSignature !== undefined
              ? { thinkingSignature: block.thinkingSignature }
              : {}),
            ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
          };
        case "toolCall":
          return { type: "toolCall", toolCall: portableToolCall(block.toolCall) };
        case "image":
          return { type: "image", data: block.data, mimeType: block.mimeType };
      }
    }),
    ...(message.source !== undefined ? { source: portableSource(message.source) } : {}),
    ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}),
    ...(message.responseId !== undefined ? { responseId: message.responseId } : {}),
    ...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}),
  };
}
