import { CrankError } from "@sweatpants/durable-execution";
import type { Message as ChatMessage } from "@sweatpants/chat-core";
import type {
  PortableModelAssistantBlock,
  PortableModelContextMessage,
} from "@sweatpants/model-provider";

/**
 * Projects canonical Chat Core history once into the provider-owned settled
 * context. Activity is private output state; every other supported role has an
 * explicit mapping and no unknown role can fall back to user.
 */
export function projectChatHistory(
  messages: readonly ChatMessage[],
): PortableModelContextMessage[] {
  return messages.flatMap((message): PortableModelContextMessage[] => {
    switch (message.role) {
      case "activity":
        return [];
      case "developer":
      case "system":
        return [{ role: "system", content: message.content }];
      case "user":
        return [{ role: "user", content: message.content }];
      case "reasoning":
        return [
          {
            role: "assistant",
            content: [{ type: "thinking", text: message.content }],
          },
        ];
      case "assistant": {
        const content: PortableModelAssistantBlock[] = [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
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
            content: message.content,
            isError: message.isError === true,
          },
        ];
      }
    }
  });
}
