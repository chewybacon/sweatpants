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

import type { ComponentType } from "react";
import type { Operation } from "@standard-durability/core";
import type { ElicitMetadata } from "@sweatpan.ts/tools";
// The component owns its concrete reply type; never permits every response callback
// here without widening the inferred result to unknown or any.
import type { RespondingProps } from "./types.ts";
export interface ReactElicitCapabilities<Y> {
  render<Props extends RespondingProps>(
    component: ComponentType<Props>,
    props: Omit<Props, "onRespond">,
  ): Operation<Parameters<Props["onRespond"]>[0], Y>;
}
export interface ElicitRender {
  readonly id: string;
  readonly interaction: ElicitMetadata;
  readonly node: ReactNode;
}

/** Frontend-local external store. Nodes are never serialized into public history. */
export interface ElicitRenderSource {
  getSnapshot(): readonly ElicitRender[];
  subscribe(notify: () => void): () => void;
}
export interface ElicitViewsProps {
  readonly host: ElicitRenderSource;
  readonly execution?: string;
}
