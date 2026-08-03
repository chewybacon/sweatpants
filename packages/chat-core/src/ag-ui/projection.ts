import type { Message } from "@ag-ui/core";
import type { Message as InternalMessage } from "../messages.ts";
import { internalMessagesToAgUiMessages } from "./messages.ts";

/** Provider history excludes private activity records. */
export function providerHistoryMessages(messages: InternalMessage[]): InternalMessage[] {
  return messages.filter((message) => message.role !== "activity");
}

/** Project the public provider history without any frontend replay state. */
export function toProviderHistorySnapshot(messages: InternalMessage[]): Message[] {
  return internalMessagesToAgUiMessages(providerHistoryMessages(messages));
}
