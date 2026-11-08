import type { ChatCompactionRequest, ChatHistoryMessage } from "./contracts.ts";
import { assertCompleteHistory } from "./history.ts";

/** Select [0, through) from a complete conversation view. Rejects empty/out-of-range
 * prefixes, instruction-only prefixes and cuts through tool-call/result groups.
 * No model call, journal write or automatic boundary selection is performed. */
export function prepareChatCompaction(
  history: readonly ChatHistoryMessage[],
  through: number,
): ChatCompactionRequest {
  if (!Number.isSafeInteger(through) || through <= 0 || through > history.length) {
    throw new Error("Invalid compaction boundary");
  }
  assertCompleteHistory(history);
  const prefix = structuredClone(history.slice(0, through));
  assertCompleteHistory(prefix);
  if (!prefix.some((message) => message.role !== "system" && message.role !== "developer")) {
    throw new Error("Compaction requires conversation content");
  }
  return { prefix };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key: string, part: unknown) => {
    if (part !== null && typeof part === "object" && !Array.isArray(part)) {
      return Object.fromEntries(
        Object.entries(part).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return part;
  });
}

/** Apply an accepted summary to its exact original prefix, returning a detached
 * view. Preserves prefix system/developer instructions verbatim and the full suffix.
 * The summary is a labelled user message, never elevated to an instruction role.
 * Does not mutate, delete or persist source history. Blank summaries and changed
 * source prefixes reject; appending a complete suffix is supported. */
export function applyChatCompaction(
  history: readonly ChatHistoryMessage[],
  request: ChatCompactionRequest,
  summary: string,
): ChatHistoryMessage[] {
  if (!summary.trim()) {
    throw new Error("Compaction summary must not be blank");
  }
  const current = prepareChatCompaction(history, request.prefix.length);
  if (canonical(current.prefix) !== canonical(request.prefix)) {
    throw new Error("Compaction prefix does not match conversation history");
  }
  return structuredClone([
    ...current.prefix.filter(
      (message) => message.role === "system" || message.role === "developer",
    ),
    { role: "user" as const, content: `Summary of earlier conversation:\n${summary}` },
    ...history.slice(request.prefix.length),
  ]);
}
