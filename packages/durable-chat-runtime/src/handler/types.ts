export type { Capabilities, Message, TokenUsage } from "@sweatpants/chat-core";
export type { Message as ChatMessage } from "@sweatpants/chat-core";

export interface ResumeEntry {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}

export type {
  ChatSessionStreamEvent as StreamEvent,
  ConversationState,
  ElicitRequestStreamEvent,
} from "@sweatpants/chat-core";
