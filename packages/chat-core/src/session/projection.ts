import type { ChatState, ChatStateInternal } from "../state/chat-state.ts";
import { createInitialChatStateInternal } from "../state/chat-state.ts";
import type { ChatStateEvent } from "../state/events.ts";
import { reduceChatState } from "../state/reducer.ts";

/** Pure fold of one canonical or local chat fact into package-private view state. */
export function foldChatState(
  state: ChatStateInternal,
  event: ChatStateEvent,
  observedAt: number,
): ChatStateInternal {
  return reduceChatState(state, event, observedAt);
}

/** Remove reducer-only drafts before state crosses the Chat Core seam. */
export function publicChatState(state: ChatStateInternal): ChatState {
  const { messageDrafts: _messageDrafts, toolCallDrafts: _toolCallDrafts, ...view } = state;
  return view;
}

/**
 * Small mutable shell used by replay helpers. The transition it delegates to is
 * pure; live session semantics use `transitionSession` from `machine.ts`.
 */
export interface ChatStateProjection {
  readonly state: ChatState;
  fold(event: ChatStateEvent, observedAt: number): void;
}

export function createChatStateProjection(): ChatStateProjection {
  let state = createInitialChatStateInternal();
  return {
    get state() {
      return publicChatState(state);
    },
    fold(event, observedAt) {
      state = foldChatState(state, event, observedAt);
    },
  };
}
