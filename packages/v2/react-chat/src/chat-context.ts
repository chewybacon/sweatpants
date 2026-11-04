import { createContext, createElement, useContext, useMemo } from "react";
import type { ChatClient } from "@sweatpan.ts/chat-client";
import type { ChatProviderProps, ChatState } from "./contracts.ts";
import { useChat as useChatSource } from "./use-chat.ts";

/** Declare once outside components. Each declaration isolates a typed conversation
 * context; each provider selects a caller-owned client without creating any work. */
export function createChatContext<V, Command, Receipt>() {
  const Context = createContext<ChatClient<V, Command, Receipt> | undefined>(undefined);
  function ChatProvider({ client, children }: ChatProviderProps<V, Command, Receipt>) {
    return createElement(Context.Provider, { value: client }, children);
  }
  function useChat(): ChatState<V, Command, Receipt> {
    const client = useContext(Context);
    if (!client) {
      throw new Error("useChat must be used within its ChatProvider");
    }
    const snapshot = useChatSource(client);
    const actions = useMemo(
      () => ({ answer: client.answer.bind(client), refresh: client.refresh.bind(client) }),
      [client],
    );
    return useMemo(() => ({ ...snapshot, ...actions }), [snapshot, actions]);
  }
  return { ChatProvider, useChat };
}
