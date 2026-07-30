/**
 * lib/chat/messages.ts
 *
 * Core chat message types — Message, ToolCall, ChatEvent, ChatResult.
 *
 * This file is the canonical owner of the universal message contract that all
 * chat providers and consumers share. It has zero imports from session/state/
 * streaming modules, which breaks the historic `types.ts` cycle hub.
 *
 * Provider-specific request/response shapes (Ollama, client-tool schema) are
 * also defined here because they are pure data types with no behavioural
 * dependencies.
 */
import type { TokenUsage } from "./core-types.ts";
import type { Json } from "@sweatpants/foundation";

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
  /**
   * Whether a tool result represents failure. This is data, carried from the
   * producer that knows. It is never inferred from the content text: a tool may
   * legitimately return output that begins with "Error:".
   */
  isError?: boolean;
  activityType?: string;
  replay?: {
    toolName?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trace?: any[];
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
    /** Open until the authored tool's parameter schema narrows it at `execute`. */
    arguments: Json;
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
