/**
 * lib/chat/messages.ts
 *
 * Core chat message, event, and settled result types.
 *
 * Settled decoded tool calls are owned by `@sweatpants/model-provider`; Chat
 * Core carries that producer-established representation unchanged.
 */
import type { ToolCall } from "@sweatpants/model-provider";
import type { TokenUsage } from "./core-types.ts";

// =============================================================================
// MESSAGE TYPES
// =============================================================================

/**
 * Universal message interface that all chat providers must support.
 * This provides a common contract for message passing between layers.
 */
export interface Message {
  id: string;
  role: "developer" | "system" | "user" | "assistant" | "tool" | "activity" | "reasoning";
  content: string;
  partial?: boolean;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Producer-owned settled tool target for `role: "tool"`. */
  name?: string;
  /**
   * Whether a tool result represents failure. This is data, carried from the
   * producer that knows. It is never inferred from the content text: a tool may
   * legitimately return output that begins with "Error:".
   */
  isError?: boolean;
  activityType?: string;
  replay?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trace?: any[];
  };
}

// =============================================================================
// PROVIDER EVENT TYPES
// =============================================================================

/**
 * Events emitted by chat providers during streaming.
 */
export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_calls"; toolCalls: ToolCall[] };

/**
 * Final result from a chat provider.
 */
export interface ChatResult {
  text: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
}
