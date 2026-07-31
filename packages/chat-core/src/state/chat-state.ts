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

/** Client projection of the canonical AG-UI event log. */
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
}

/** Reducer-only bookkeeping; consumers receive only the semantic ChatState view. */
export interface ChatStateInternal extends ChatState {
  messageDrafts: Record<string, MessageDraft>;
  toolCallDrafts: Record<string, ToolCallDraft>;
}

export function createInitialChatStateInternal(): ChatStateInternal {
  return {
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
}

const initialChatStateInternal = createInitialChatStateInternal();

/** Public initial view; reducer bookkeeping is intentionally not part of it. */
const {
  messageDrafts: _initialMessageDrafts,
  toolCallDrafts: _initialToolCallDrafts,
  ...initialChatStateView
} = initialChatStateInternal;
export const initialChatState: ChatState = initialChatStateView;
