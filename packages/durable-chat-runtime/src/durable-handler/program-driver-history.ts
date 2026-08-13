import { decodeChatHistoryEntries, type ChatHistoryEntry } from "@sweatpants/chat-core";
import { assertJson, stableTupleHash, type Json } from "@sweatpants/foundation";

/**
 * Encode semantic Chat History for the durable chat-root input boundary.
 *
 * The journal stores the owner-decoded history-entry composition. Model
 * projection happens later at the durable program boundary, where the
 * projected messages are consumed by Model Context construction.
 */
export function encodeChatHistoryEntriesForProgramInput(
  entries: readonly ChatHistoryEntry[],
): Json[] {
  const decoded = decodeChatHistoryEntries(
    entries.map((entry) => assertJson(entry)),
    "$.messages",
  );
  const completedToolCallIds = new Set(
    decoded.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "tool" ? [entry.message.toolCallId] : [],
    ),
  );
  const normalized: ChatHistoryEntry[] = [];
  for (const entry of decoded) {
    normalized.push(entry);
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    for (const part of entry.message.content) {
      if (part.type !== "tool-call" || completedToolCallIds.has(part.toolCall.id)) {
        continue;
      }
      normalized.push({
        type: "message",
        id: stableTupleHash(["cancelled-tool-result", entry.id, part.toolCall.id]),
        message: {
          role: "tool",
          toolCallId: part.toolCall.id,
          name: part.toolCall.name,
          content: "Tool call was cancelled before its result was available.",
          isError: true,
        },
        metadata: { synthetic: true, reason: "incomplete-tool-call" },
      });
    }
  }
  return normalized.map((entry) => assertJson(entry));
}
