import { CrankError } from "@sweatpants/durable-execution";
import type { ChatMessageContent, Message as ChatMessage } from "@sweatpants/chat-core";
import type {
  PortableModelAssistantBlock,
  PortableModelContextMessage,
  PortableModelInputBlock,
} from "@sweatpants/model-provider";

function textContent(content: ChatMessageContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function inputContent(content: ChatMessageContent): string | PortableModelInputBlock[] {
  if (typeof content === "string") {
    return content;
  }
  return content.flatMap((part): PortableModelInputBlock[] => {
    if (part.type === "text") {
      return [{ type: "text", text: part.text }];
    }
    if (part.type === "image" && part.source.type === "data") {
      return [{ type: "image", data: part.source.value, mimeType: part.source.mimeType }];
    }
    return [];
  });
}

/**
 * Projects canonical Chat Core history once into the provider-owned settled
 * context. Activity is private output state; every other supported role has an
 * explicit mapping and no unknown role can fall back to user.
 */
export function projectChatHistory(
  messages: readonly ChatMessage[],
): PortableModelContextMessage[] {
  // Settled role projection must enumerate every supported role without a fallback.
  // fallow-ignore-next-line complexity
  return messages.flatMap((message): PortableModelContextMessage[] => {
    switch (message.role) {
      case "activity":
        return [];
      case "developer":
      case "system":
        return [{ role: "system", content: textContent(message.content) }];
      case "user":
        return [{ role: "user", content: inputContent(message.content) }];
      case "reasoning":
        return [
          {
            role: "assistant",
            content: [{ type: "thinking", text: textContent(message.content) }],
          },
        ];
      case "assistant": {
        const assistantText = textContent(message.content);
        const content: PortableModelAssistantBlock[] = [
          ...(assistantText ? [{ type: "text" as const, text: assistantText }] : []),
          ...(message.tool_calls ?? []).map((call) => ({
            type: "toolCall" as const,
            toolCall: {
              id: call.id,
              type: "function" as const,
              function: {
                name: call.function.name,
                arguments: call.function.arguments,
              },
              ...(call.thoughtSignature !== undefined
                ? { thoughtSignature: call.thoughtSignature }
                : {}),
            },
          })),
        ];
        return [{ role: "assistant", content }];
      }
      case "tool": {
        if (!message.tool_call_id || !message.name) {
          throw new CrankError(
            "invalid_chat_request",
            "Settled tool history requires tool_call_id and name",
          );
        }
        return [
          {
            role: "tool",
            tool_call_id: message.tool_call_id,
            name: message.name,
            content: inputContent(message.content),
            isError: message.isError === true,
          },
        ];
      }
    }
  });
}
