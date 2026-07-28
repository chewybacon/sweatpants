import type { Message } from "../messages.ts";
import type { MessagePart } from "../types/chat-message.ts";
import type { ConversationReplayState } from "../session/replay-types.ts";
import type {
  ElicitState,
  ElicitTrackingState,
  ToolEmissionState,
  ToolEmissionTrackingState,
} from "./interactions.ts";

export type { ElicitState, ElicitTrackingState, ToolEmissionState, ToolEmissionTrackingState };

export interface StreamingPartsState {
  parts: MessagePart[];
  activePartId: string | null;
  activePartType: "text" | "reasoning" | "tool-call" | null;
}

interface MessageDraft {
  id: string;
  role: "assistant" | "user" | "system" | "developer";
  content: string;
}

interface ToolCallDraft {
  id: string;
  name: string;
  arguments: string;
  parentMessageId: string;
  ended: boolean;
}

/**
 * Client projection of the canonical AG-UI event log.
 *
 * `messageDrafts` and `toolCallDrafts` are fold bookkeeping. They are public in
 * the structural type so the reducer remains a pure serializable function; UI
 * consumers should use `messages`, `streaming`, and the derivation helpers.
 */
export interface ChatState {
  messages: Message[];
  finalizedParts: Record<string, MessagePart[]>;
  isStreaming: boolean;
  streaming: StreamingPartsState;
  error: string | null;
  pendingElicits: Record<string, ElicitTrackingState>;
  toolEmissions: Record<string, ToolEmissionTrackingState>;
  replay?: ConversationReplayState;
  activeRun: { threadId: string; runId: string } | null;
  readonly messageDrafts: Readonly<Record<string, MessageDraft>>;
  readonly toolCallDrafts: Readonly<Record<string, ToolCallDraft>>;
}

export const initialChatState: ChatState = {
  messages: [],
  finalizedParts: {},
  isStreaming: false,
  streaming: { parts: [], activePartId: null, activePartType: null },
  error: null,
  pendingElicits: {},
  toolEmissions: {},
  activeRun: null,
  messageDrafts: {},
  toolCallDrafts: {},
};
