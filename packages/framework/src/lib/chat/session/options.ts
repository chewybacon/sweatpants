/**
 * lib/chat/session/options.ts
 *
 * Session configuration types.
 */

import type { Operation, Channel } from "effection";
import type { ChatStateEvent } from "../state/events.ts";
import type { Message } from "../types.ts";
import type { StreamEvent, StreamResult } from "./streaming.ts";
import type { ConversationReplayState } from "./streaming.ts";
import type { ToolExecutionTrace } from "../browser-rendering/emissions.ts";
import type { PluginHandleInput } from "../mcp-tools/plugin.ts";
import type { StreamOptions } from "../runtime/index.ts";

// =============================================================================
// STREAM EVENT OBSERVATION
// =============================================================================

/**
 * Entry passed to the `onStreamEvent` callback.
 *
 * Provides raw wire-level visibility into every durable stream event,
 * both during live streaming and durable history replay.
 */
export interface StreamEventEntry {
  /** Log sequence number from the durable frame */
  lsn: number;
  /** The raw stream event */
  event: StreamEvent;
  /** Whether the event was received live or replayed from history */
  phase: "live" | "replay";
  /** Timestamp (Date.now()) when the event was observed */
  receivedAt: number;
}

// =============================================================================
// ELICIT RESPONSE DATA
// =============================================================================

/**
 * Elicit response from the client.
 */
export interface ElicitResponseData {
  /** Session ID (same as callId from the original tool call) */
  sessionId: string;
  /** Original tool call ID for conversation correlation */
  callId: string;
  /** Canonical tool name for continuation validation */
  toolName?: string;
  /** Optional runtime execution ref echoed from durable pending state */
  ref?: {
    runtimeId: string;
    executionId: string;
    callId: string;
    toolName: string;
    sessionId?: string;
  };
  /** Specific elicit request ID */
  elicitId: string;
  /** The user's response */
  result: {
    action: "accept" | "decline" | "cancel";
    content?: unknown;
  };
  /** Browser render trace for replaying plugin UI after refresh. */
  trace?: ToolExecutionTrace;
}

// =============================================================================
// STREAMER
// =============================================================================

/**
 * A streamer is an Operation that performs a streaming chat request.
 *
 * This abstraction allows us to swap out the real fetch-based streamer
 * for a test streamer that we can control step-by-step.
 */
export type Streamer = (
  messages: Message[],
  events: Channel<ChatStateEvent, void>,
  options: Omit<StreamChatOptions, "streamer">,
) => Operation<StreamResult>;

// =============================================================================
// MESSAGE RENDERER
// =============================================================================

/**
 * A message renderer transforms message content to HTML.
 *
 * Used for rendering completed messages (both user and assistant).
 * This is simpler than the streaming processor - just a sync function.
 *
 * @param content - The raw message content
 * @returns HTML string, or undefined to skip rendering
 */
export type MessageRenderer = (content: string) => string | undefined;

// =============================================================================
// EVENT TRANSFORM
// =============================================================================

/**
 * A client event transform observes canonical AG-UI events and may add
 * explicitly local rendering actions. It MUST NOT rename wire events.
 */
export type ChatEventTransform = (
  input: Channel<ChatStateEvent, void>,
  output: Channel<ChatStateEvent, void>,
) => Operation<void>;

// =============================================================================
// SESSION OPTIONS
// =============================================================================

/** Fetch-compatible transport dependency used by chat POST and history reads. */
export type ChatFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Configuration for a chat session.
 */
export interface SessionOptions {
  /**
   * Optional transport dependency. Defaults to ambient `fetch`.
   */
  fetch?: ChatFetch;

  /**
   * Base URL for the chat API.
   * Defaults to '/api/chat'.
   */
  baseUrl?: string;

  /**
   * Tools to enable for this session by object reference. The client sends
   * their names as `enabledTools`; server execution comes from ToolInventory.
   */
  tools?: unknown[];

  /**
   * Plugin handles to enable for this session.
   *
   * Pass concrete plugin objects (the return value of
   * `makePlugin(tool).onElicit({...}).build()`). The framework derives the
   * server-side `enabledPlugins` list automatically from each plugin's
   * `client.toolName` and registers client-side elicitation handlers from
   * `plugin.client`.
   *
   * ```typescript
   * useChat({
   *   plugins: [bookFlightPlugin, tictactoePlugin],
   * })
   * ```
   *
   * The old `enabledPlugins` string array option is removed — plugin tool
   * exposure is derived from the `plugins` array.
   */
  plugins?: PluginHandleInput[];

  /**
   * Tools to enable by name (for server-side tool selection).
   * Can be an array of tool names or `true` to enable all tools.
   *
   * For client-side tool configuration, prefer using `tools` instead
   * which takes tool objects directly.
   */
  enabledTools?: string[] | boolean;

  /**
   * System prompt for manual mode.
   * Only used when `persona` is not set.
   */
  systemPrompt?: string;

  /**
   * Persona name (persona mode).
   * Mutually exclusive with tools/enabledTools.
   */
  persona?: string;

  /**
   * Configuration for the persona.
   */
  personaConfig?: Record<string, boolean | number | string>;

  /**
   * Optional tools to enable for the persona.
   */
  enableOptionalTools?: string[];

  /**
   * Effort level for the persona.
   */
  effort?: "auto" | "low" | "medium" | "high";

  /**
   * Provider stream options for this session.
   */
  streamOptions?: StreamOptions;

  /**
   * Tool choice override for only the first model call in a new chat request.
   * This is useful for acceptance/demo routes that expose exactly one tool and
   * require the model to start by calling it, without forcing follow-up turns
   * after tool completion to call another tool.
   */
  initialToolChoice?: StreamOptions["toolChoice"];

  /**
   * Event transforms - observe AG-UI events and add local rendering actions.
   */
  transforms?: ChatEventTransform[];

  /**
   * Renderer for completed messages.
   */
  renderer?: MessageRenderer;

  /**
   * Custom streamer for dependency injection (primarily for testing).
   */
  streamer?: Streamer;

  /**
   * Whether to preserve partial responses when the user aborts.
   * @default true
   */
  preservePartialOnAbort?: boolean;

  /**
   * Suffix to append to aborted message content.
   * Only applies if preservePartialOnAbort is true.
   * @default ''
   */
  abortSuffix?: string;

  /**
   * Conversation ID for durable streaming.
   * When provided, the server loads history from the durable stream
   * and appends new messages to it. Enables reconnect after refresh.
   */
  conversationId?: string;

  /**
   * Callback invoked for every raw durable stream event.
   *
   * Fires during both live streaming and durable history replay,
   * providing wire-level visibility into the event flow.
   *
   * When `undefined` (the default), no observation overhead is incurred.
   *
   * @example
   * ```tsx
   * useChat({
   *   onStreamEvent: (entry) => {
   *     console.log(`[${entry.phase}] LSN ${entry.lsn}: ${entry.event.type}`)
   *   },
   * })
   * ```
   */
  onStreamEvent?: (entry: StreamEventEntry) => void;

  /**
   * Called after one request has fully settled and its result has been folded
   * into the persistent client-session history. Primarily supports semantic
   * test drivers that must not race the next turn against history projection.
   */
  onTurnSettled?: (result: StreamResult) => void;

  /** Called after a request task terminates with an error, after stream cleanup. */
  onRequestError?: (error: unknown) => void;

  /** Called after a request task has released session ownership in its finally block. */
  onRequestFinished?: () => void;
}

// =============================================================================
// STREAM CHAT OPTIONS
// =============================================================================

/**
 * Options for streamChatOnce.
 */
export interface StreamChatOptions extends SessionOptions {
  replayState?: ConversationReplayState;
  /** Explicit server-side cancellation of the active Program Runtime task tree. */
  pluginAbort?: { sessionId: string; reason?: string };

  /**
   * Elicit responses to pending elicitation requests.
   * Sent when resuming a conversation with tool elicitations.
   */
  elicitResponses?: ElicitResponseData[];

  /**
   * Conversation ID for durable streaming.
   * When provided, the server loads history from the durable stream
   * and appends new messages to it. Enables reconnect after refresh.
   */
  conversationId?: string;
}

// =============================================================================
// COMMANDS
// =============================================================================

/**
 * Commands that can be sent to a chat session.
 */
export type ChatCommand =
  | {
      type: "send";
      content: string;
      /** Raw assistant text currently streaming when this send interrupts a run. */
      partialContent?: string;
    }
  | {
      type: "abort";
      /** Raw text from UI buffer (settled + pending) */
      partialContent?: string;
      /** Rendered HTML (settled only, for display) */
      partialHtml?: string;
    }
  | { type: "reset" }
  | {
      /**
       * Continue the conversation without adding a user message.
       * Used for resuming after plugin elicitation responses.
       */
      type: "continue";
    }
  | {
      /**
       * Respond to a pending elicitation.
       * The response is stored and sent with the next message.
       */
      type: "elicit_response";
      /** Session ID (same as callId from the original tool call) */
      sessionId: string;
      /** Original tool call ID for conversation correlation */
      callId: string;
      /** Canonical tool name for continuation validation */
      toolName?: string;
      /** Optional runtime execution ref echoed from durable pending state */
      ref?: ElicitResponseData["ref"];
      /** Specific elicit request ID */
      elicitId: string;
      /** The user's response */
      result: {
        action: "accept" | "decline" | "cancel";
        content?: unknown;
      };
      /** Browser render trace for replaying plugin UI after refresh. */
      trace?: ToolExecutionTrace;
      /**
       * If true, automatically send a continuation request after storing the response.
       * This allows multi-step elicitation flows to progress without user intervention.
       * @default true
       */
      autoContinue?: boolean;
    };
