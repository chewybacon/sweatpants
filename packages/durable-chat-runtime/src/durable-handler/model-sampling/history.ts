import type { ChatHistoryEntry, ChatMessage } from "@sweatpants/chat-core";
import { UnsupportedModelCapabilityError } from "@sweatpants/model-provider";

/**
 * Unwraps durable history to the canonical Chat message graph without mapping
 * fields. Entry `id` and `metadata` are durable-wrapper facts rather than
 * conversation semantics, so projecting the message is lossless here; activity
 * entries have no model-context representation and reject explicitly.
 */
export function projectChatHistory(entries: readonly ChatHistoryEntry[]): ChatMessage[] {
  return entries.map((entry, index) => {
    const path = `$.entries[${index}]`;
    if (entry.type === "activity") {
      throw new UnsupportedModelCapabilityError(
        path,
        "activity",
        "Activity history is not a model-context message",
      );
    }
    return entry.message;
  });
}
