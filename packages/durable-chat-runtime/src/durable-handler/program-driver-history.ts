import { decodeChatHistoryEntries, type ChatHistoryEntry } from "@sweatpants/chat-core";
import { assertJson, type Json } from "@sweatpants/foundation";

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
  return decoded.map((entry) => assertJson(entry));
}
