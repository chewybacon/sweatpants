import type { ChatMessage } from "@sweatpan.ts/providers";

/** Both inference and compaction require complete tool-call/result groups. */
export function assertCompleteHistory(history: readonly ChatMessage[]): void {
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  for (const message of history) {
    if (message.role === "tool") {
      if (pending.get(message.toolCallId) !== message.name) {
        throw new Error("Tool result does not match an outstanding call");
      }
      pending.delete(message.toolCallId);
    } else if (pending.size) {
      throw new Error("Cannot infer with unresolved tool calls");
    }
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call") {
          if (seen.has(part.toolCall.id)) {
            throw new Error("Duplicate tool call identity");
          }
          seen.add(part.toolCall.id);
          pending.set(part.toolCall.id, part.toolCall.name);
        }
      }
    }
  }
  if (pending.size) {
    throw new Error("Cannot infer with unresolved tool calls");
  }
}
