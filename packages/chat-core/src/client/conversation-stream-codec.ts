import { decodeAGUIEvent } from "./chat-client-codec.ts";
import {
  CONVERSATION_AUTHORITY_FRAME_TYPE,
  decodeConversationAuthorityFrame,
  type ConversationStreamEvent,
} from "./conversation-protocol.ts";
import { CONVERSATION_WINDOW_FRAME_TYPE, decodeConversationWindow } from "./conversation-window.ts";

/** Parse one direct native Chat stream value exactly once. */
export function decodeConversationStreamEvent(value: unknown): ConversationStreamEvent {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const type = (value as Readonly<Record<string, unknown>>)["type"];
    if (type === CONVERSATION_AUTHORITY_FRAME_TYPE) {
      return decodeConversationAuthorityFrame(value);
    }
    if (type === CONVERSATION_WINDOW_FRAME_TYPE) {
      return decodeConversationWindow(value);
    }
  }
  return decodeAGUIEvent(value);
}
