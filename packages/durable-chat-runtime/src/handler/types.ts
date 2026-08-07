export type { Capabilities, TokenUsage, ChatHistoryEntry } from "@sweatpants/chat-core";

export interface ResumeEntry {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}

export type { AGUIEvent as StreamEvent } from "@ag-ui/core";
export type { ElicitRequestStreamEvent } from "@sweatpants/chat-core";
