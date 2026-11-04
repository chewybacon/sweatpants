import type { ReactNode } from "react";
import type { ChatClient, ChatViewSnapshot } from "@sweatpan.ts/chat-client";

/** The embedding application owns initial refresh, client and transport lifetime. */
export interface ChatProviderProps<V, Command, Receipt> {
  readonly client: ChatClient<V, Command, Receipt>;
  readonly children?: ReactNode;
}
/** Shared observation and explicit commands, with no implicit execution policy. */
export type ChatState<V, Command, Receipt> = ChatViewSnapshot<V> &
  Pick<ChatClient<V, Command, Receipt>, "answer" | "refresh">;
