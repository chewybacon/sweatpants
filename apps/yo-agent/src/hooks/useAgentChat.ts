/** Thin Ink-facing adapter over the headless ChatClient external store. */
import { useCallback, useSyncExternalStore } from "react";
import type { ChatMessage, ChatSnapshot } from "@sweatpants/chat-client";
import type { TerminalChatClient, TerminalPromptPart } from "../terminal/interaction.ts";

export interface AgentChatState {
  readonly messages: readonly ChatMessage<TerminalPromptPart>[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly send: (content: string) => void;
}

export function useAgentChat(client: TerminalChatClient): AgentChatState {
  const snapshot: ChatSnapshot<ChatMessage<TerminalPromptPart>> = useSyncExternalStore(
    client.subscribe.bind(client),
    client.getSnapshot.bind(client),
    client.getServerSnapshot.bind(client),
  );
  const send = useCallback(
    (content: string) => {
      // Request failures are published on the client snapshot and rendered by the sidebar.
      void client.sendMessage({ text: content }).catch(() => undefined);
    },
    [client],
  );

  return {
    messages: snapshot.messages,
    busy: snapshot.status === "submitted" || snapshot.status === "streaming",
    error: snapshot.error?.message ?? null,
    send,
  };
}
