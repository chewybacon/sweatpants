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

import type { EffectDefinition } from "@sweatpan.ts/core";
import type { Outcome } from "@standard-durability/core";
import type { ToolPresentationQuestion, ToolPresentationSource } from "@sweatpan.ts/chat-client";

/** Renderer props are inferred from the authored effect. Submitted values have the
 * handler-input type; accepted outcomes have the transformed authored-result type. */
export type ToolUIProps<E> =
  E extends EffectDefinition<infer C, infer R, unknown, infer A, infer F>
    ? {
        readonly input: C;
        readonly state: ToolPresentationQuestion["state"];
        readonly delivery: ToolPresentationQuestion["delivery"];
        readonly disabled: boolean;
        readonly submitted?: Outcome<A, F>;
        readonly outcome?: Outcome<R, F>;
        readonly error?: string;
        respond(value: A): Promise<void>;
        /** Available only when the source supports domain failure answers. */
        decline?(error: F): Promise<void>;
      }
    : never;

/** Immutable renderer registration. It owns no client, task or answer authority. */
export interface ToolUIPlugin {
  readonly program: string;
  render(question: ToolPresentationQuestion): ReactNode;
}
export interface ToolUIProviderProps {
  readonly source: ToolPresentationSource;
  readonly plugins: readonly ToolUIPlugin[];
  /** One destination per question. Defaults to "inline". History may stay inline
   * while open controls go elsewhere. A destination has one matching outlet. */
  readonly placement?: (question: ToolPresentationQuestion) => string;
  readonly children?: ReactNode;
}
export interface ToolOutletProps {
  readonly placement?: string;
  /** Select an exact invocation or question when embedding inside a message tree. */
  readonly execution?: string;
  readonly question?: string;
}
