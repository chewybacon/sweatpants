import type { Message } from "@ag-ui/core";
import { chatHistoryEntriesToAgUiMessages } from "./history.ts";
import type { ChatHistoryEntry } from "../history.ts";

/** Provider history excludes private activity records. */
export function providerHistoryEntries(
  entries: readonly ChatHistoryEntry[],
): readonly ChatHistoryEntry[] {
  return entries.filter((entry) => entry.type !== "activity");
}

/** Project semantic Chat History to the public AG-UI provider snapshot. */
export function toProviderHistorySnapshot(entries: readonly ChatHistoryEntry[]): Message[] {
  return [...chatHistoryEntriesToAgUiMessages(providerHistoryEntries(entries))];
}
