/** Framework-neutral projection of Chat Core messages. */
import type { ChatState } from "./chat-state.ts";
import type {
  ChatMessage,
  MessagePart,
  TextPart,
  ToolCallPart,
  ActiveMessageProjection,
} from "../types/chat-message.ts";

function partsForMessage(state: ChatState, messageId: string): MessagePart[] {
  const stored = state.finalizedParts[messageId];
  if (stored && stored.length > 0) {
    return stored;
  }
  const message = state.messages.find((candidate) => candidate.id === messageId);
  if (!message) {
    return [];
  }
  const parts: MessagePart[] = [];
  if (message.content) {
    parts.push({
      id: `${messageId}-text`,
      type: "text",
      content: message.content,
      rendered: message.content,
    } satisfies TextPart);
  }
  for (const call of message.tool_calls ?? []) {
    const result = state.messages.find(
      (candidate) => candidate.role === "tool" && candidate.tool_call_id === call.id,
    );
    const failed = result?.isError === true;
    const part: ToolCallPart = {
      id: `${messageId}-tool-${call.id}`,
      type: "tool-call",
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      state: result ? (failed ? "error" : "complete") : "running",
      ...(result && !failed ? { result: result.content } : {}),
      ...(failed && result ? { error: result.content } : {}),
    };
    parts.push(part);
  }
  return parts;
}

export function deriveCompletedMessages(state: ChatState): ChatMessage[] {
  return state.messages
    .filter(
      (message) =>
        message.role === "user" || message.role === "assistant" || message.role === "system",
    )
    .map((message) => ({
      id: message.id,
      role: message.role as ChatMessage["role"],
      parts: partsForMessage(state, message.id),
      active: false,
    }));
}

export function deriveActiveMessageProjection(state: ChatState): ActiveMessageProjection | null {
  if (!state.active) {
    return null;
  }
  return {
    role: "assistant",
    parts: state.streaming.parts,
    activePartId: state.streaming.activePartId,
  };
}

export function deriveMessages(state: ChatState): ChatMessage[] {
  const completed = deriveCompletedMessages(state);
  const streaming = deriveActiveMessageProjection(state);
  if (!streaming) {
    return completed;
  }
  return [
    ...completed,
    {
      id: "streaming",
      role: "assistant",
      parts: streaming.parts,
      active: true,
    },
  ];
}
