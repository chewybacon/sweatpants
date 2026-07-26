/**
 * lib/chat/types.ts
 *
 * Core chat types - messages, provider events, and API types.
 * This file defines types specific to the chat protocol layer.
 *
 * For shared primitives, see: core-types.ts
 * For patches, see: patches/
 * For state, see: state/
 * For session config, see: session/
 */

// Re-export shared primitives from core-types
export type {
  Capabilities,
  BaseContentMetadata,
  ContentMetadata,
  RenderDelta,
  RevealHint,
  TokenUsage,
  ToolCallInfo,
  ServerToolResult,
} from "./core-types.ts";
import type { ConversationReplayToolTrace } from "./session/streaming.ts";

export type {
  AgUiCheckpoint,
  AgUiCustomState,
  AgUiRunMetadata,
  ConversationState,
  ConversationReplayToolTrace,
  StreamResult,
  StreamCompleteResult,
  StreamEvent,
} from "./session/streaming.ts";
export type {
  Streamer,
  MessageRenderer,
  ChatEventTransform,
  SessionOptions,
  ChatCommand,
} from "./session/options.ts";

export type {
  TimelineUserMessage,
  TimelineAssistantText,
  TimelineThinking,
  TimelineToolCall,
  TimelineStep,
  TimelineItem,
  TimelineToolCallGroup,
  GroupedTimelineItem,
  ChatState,
  ChatStateEvent,
  LocalChatAction,
  LocalEmissionAction,
  ToolEmissionState,
  ToolEmissionTrackingState,
} from "./state/index.ts";

export { groupTimelineByToolCall, initialChatState } from "./state/index.ts";

// =============================================================================
// MESSAGE TYPES (defined here - core to the chat protocol)
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
  activityType?: string;
  replay?: {
    toolName?: string;
    trace?: ConversationReplayToolTrace["trace"];
  };
}

/**
 * Tool call structure — canonical nested (OpenAI-compatible) format.
 *
 * Used by Message.tool_calls, ChatEvent, ChatResult, and the durable engine.
 * All providers normalise into this shape before it enters the framework.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: Record<string, unknown>;
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

// =============================================================================
// CLIENT TOOL SCHEMA
// =============================================================================

/**
 * Schema for a client-side tool, sent to the server so it can be
 * included in the LLM request. The server doesn't execute these -
 * it passes them to the LLM and hands back to the client for execution.
 */
export interface ClientToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// =============================================================================
// OLLAMA REQUEST/RESPONSE TYPES
// =============================================================================

/**
 * Ollama chat request format.
 */
export interface OllamaChatRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  /** Tool choice: 'auto' (default), 'none', 'required', or specific tool name */
  tool_choice?: "auto" | "none" | "required" | string;
  /** Format for structured output: 'json' or a JSON schema object */
  format?: "json" | Record<string, unknown>;
}

/**
 * Ollama chat response chunk.
 */
export interface OllamaChatChunk {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
    thinking?: string; // DeepSeek-R1 style
    tool_calls?: ToolCall[];
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  error?: string;
}
import type { TokenUsage } from "./core-types.ts";
