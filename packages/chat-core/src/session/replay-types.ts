/**
 * lib/chat/session/replay-types.ts
 *
 * Replay trace types shared between streaming.ts and plugin-replay.ts.
 *
 * Extracted to break the cycle:
 *   streaming.ts → ag-ui-messages.ts → plugin-replay.ts → streaming.ts
 *
 * plugin-replay.ts now imports ConversationReplayToolTrace from this leaf
 * module instead of from streaming.ts, removing the back-edge.
 */
import type { ToolExecutionTrace } from "@sweatpants/chat-core";

export interface ConversationReplayToolTrace {
  callId: string;
  toolName: string;
  trace: ToolExecutionTrace;
}

export interface ConversationReplayState {
  toolTraces: ConversationReplayToolTrace[];
}
