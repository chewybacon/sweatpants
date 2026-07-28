import type { Frame } from "../frame.ts";
import type { MessagePart } from "../types/chat-message.ts";
import type { Message } from "../messages.ts";

type ContentPartType = "text" | "reasoning";
import type { StreamEvent } from "../session/streaming.ts";
import type { ToolEmissionTrackingState } from "./interactions.ts";

/**
 * Actions which exist only inside the client process. Durable and streamed
 * conversation facts MUST be represented by canonical AG-UI StreamEvent values.
 */
export type LocalChatAction =
  | { type: "LOCAL_USER_MESSAGE"; message: Message }
  | { type: "LOCAL_ASSISTANT_MESSAGE"; message: Message; partial?: boolean }
  | { type: "LOCAL_RENDER_FRAME"; partType: ContentPartType; partId: string; frame: Frame }
  | { type: "LOCAL_RENDER_END"; partType: ContentPartType; partId: string; frame: Frame }
  | { type: "LOCAL_ELICIT_RESPONSE"; callId: string; elicitId: string; response: unknown }
  | { type: "LOCAL_REPLAY_EMISSIONS"; tracking: ToolEmissionTrackingState }
  | { type: "LOCAL_FINALIZED_PARTS"; messageId: string; parts: MessagePart[] }
  | { type: "LOCAL_ABORT"; message?: Message }
  | { type: "LOCAL_ERROR"; message: string }
  | { type: "LOCAL_RESET" };

/** The only inputs accepted by the chat state fold. */
export type ChatStateEvent = StreamEvent | LocalChatAction;

export function isLocalChatAction(event: ChatStateEvent): event is LocalChatAction {
  return event.type.startsWith("LOCAL_");
}
