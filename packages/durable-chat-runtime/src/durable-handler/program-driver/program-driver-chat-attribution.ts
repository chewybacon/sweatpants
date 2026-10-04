import { stableTupleHash } from "@sweatpants/foundation";
import { parentToolStart, type ChatJournalIndex } from "./program-driver-chat-journal-index.ts";

/** Attribute only existing public tool invocations; never expose private task identities. */
export function publicSubagentRunId(index: ChatJournalIndex, taskId: string): string | undefined {
  return parentToolStart(index, taskId)
    ? stableTupleHash(["sweatpants.ag-ui.subagent.v1", taskId])
    : undefined;
}
