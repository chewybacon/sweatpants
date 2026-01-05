/**
 * lib/chat/session/options.ts
 *
 * Session configuration types.
 */

import type { Operation, Channel } from 'effection'
import type { ChatPatch } from '../patches'
import type { ApiMessage, StreamResult } from './streaming'

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
  messages: ApiMessage[],
  patches: Channel<ChatPatch, void>,
  options: Omit<SessionOptions, 'streamer'>
) => Operation<StreamResult>

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
export type MessageRenderer = (content: string) => string | undefined

// =============================================================================
// PATCH TRANSFORM
// =============================================================================

/**
 * A patch transform is an Effection operation that reads patches from
 * an input channel, transforms them, and writes to an output channel.
 */
export type PatchTransform = (
  input: Channel<ChatPatch, void>,
  output: Channel<ChatPatch, void>
) => Operation<void>

// =============================================================================
// SESSION OPTIONS
// =============================================================================

/**
 * Configuration for a chat session.
 */
export interface SessionOptions {
  /**
   * Base URL for the chat API.
   * Defaults to '/api/chat'.
   */
  baseUrl?: string

  /**
   * Whether to use durable streaming format.
   * 
   * When true, expects the server to return NDJSON with `{ lsn, event }` wrapper
   * format (as produced by `createDurableChatHandler`). The client will unwrap
   * each line to extract the inner event.
   * 
   * @default false
   */
  durable?: boolean

  /**
   * Tools to enable for this session.
   *
   * Import tools directly and pass them here:
   * ```typescript
   * import { pickCard, calculator } from '@/__generated__/tool-registry.gen'
   *
   * useChat({
   *   tools: [pickCard, calculator],
   * })
   * ```
   *
   * Only these tools will be available to the LLM.
   */
  tools?: unknown[] // Will be typed as AnyIsomorphicTool[] in the hooks

  /**
   * @deprecated Use `tools` instead.
   * Tools to enable (manual mode).
   * Can be an array of tool names or `true` to enable all.
   */
  enabledTools?: string[] | boolean

  /**
   * System prompt for manual mode.
   * Only used when `persona` is not set.
   */
  systemPrompt?: string

  /**
   * Persona name (persona mode).
   * Mutually exclusive with tools/enabledTools.
   */
  persona?: string

  /**
   * Configuration for the persona.
   */
  personaConfig?: Record<string, boolean | number | string>

  /**
   * Optional tools to enable for the persona.
   */
  enableOptionalTools?: string[]

  /**
   * Effort level for the persona.
   */
  effort?: 'auto' | 'low' | 'medium' | 'high'

  /**
   * Stream transforms - process patches before they reach React state.
   */
  transforms?: PatchTransform[]

  /**
   * Renderer for completed messages.
   */
  renderer?: MessageRenderer

  /**
   * Custom streamer for dependency injection (primarily for testing).
   */
  streamer?: Streamer

  /**
   * Whether to preserve partial responses when the user aborts.
   * @default true
   */
  preservePartialOnAbort?: boolean

  /**
   * Suffix to append to aborted message content.
   * Only applies if preservePartialOnAbort is true.
   * @default ''
   */
  abortSuffix?: string
}

// =============================================================================
// COMMANDS
// =============================================================================

/**
 * Commands that can be sent to a chat session.
 */
export type ChatCommand =
  | { type: 'send'; content: string }
  | {
      type: 'abort'
      /** Raw text from UI buffer (settled + pending) */
      partialContent?: string
      /** Rendered HTML (settled only, for display) */
      partialHtml?: string
    }
  | { type: 'reset' }
