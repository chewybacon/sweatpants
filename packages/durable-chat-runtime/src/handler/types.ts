export type { Capabilities, TokenUsage, ChatHistoryEntry } from "@sweatpants/chat-core";

export interface ResumeEntry {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}

export type { ConversationStreamEvent as StreamEvent } from "@sweatpants/chat-core";
export type { ElicitRequestStreamEvent } from "@sweatpants/chat-core";
