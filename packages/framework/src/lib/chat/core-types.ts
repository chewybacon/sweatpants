/**
 * lib/chat/core-types.ts
 *
 * Core primitive types shared across the entire chat system.
 * This is the lowest-level type module - it has NO dependencies on other chat modules.
 *
 * Types here are used by:
 * - lib/chat (message types, streaming)
 * - lib/chat/patches (patch types)
 * - lib/chat/state (chat state)
 * - lib/chat/session (session options)
 * - handler (server handler)
 * - react/chat (React hooks and components)
 */

// =============================================================================
// AUTHORITY & EXECUTION
// =============================================================================

/**
 * Determines execution order and data flow for isomorphic tools.
 *
 * - `server`: Server executes first, may yield to client, server returns final result
 * - `client`: Client executes first, server validates/processes, server returns final result
 */
export type AuthorityMode = 'server' | 'client'

/**
 * State of an isomorphic tool during execution.
 */
export type IsomorphicToolState =
  | 'pending'
  | 'server_executing'
  | 'awaiting_client_approval'
  | 'client_executing'
  | 'server_validating'
  | 'complete'
  | 'error'
  | 'denied'

// =============================================================================
// CAPABILITIES
// =============================================================================

/**
 * Capabilities reported by the chat session.
 */
export interface Capabilities {
  thinking: boolean
  streaming: boolean
  tools: string[]
}

// =============================================================================
// CONTENT METADATA
// =============================================================================

/**
 * Base metadata that can be attached to content.
 * Plugins extend this interface for their own metadata.
 */
export interface BaseContentMetadata {
  [key: string]: unknown
}

/**
 * Content metadata for patches and rendering.
 *
 * This allows processors and renderers to know context about what they're processing,
 * e.g., whether content is inside a code fence and what language it is.
 */
export interface ContentMetadata extends BaseContentMetadata {
  /** Whether this content is inside a code fence */
  inCodeFence?: boolean
  /** The language of the code fence (e.g., 'python', 'typescript') */
  language?: string
}

// =============================================================================
// RENDER SUPPORT
// =============================================================================

/**
 * Delta information for animation support.
 *
 * Contains the new content added since the previous frame,
 * enabling smooth animations and transitions in React.
 */
export interface RenderDelta {
  /** The new content added since prev frame */
  added: string
  /** HTML for just the new content (if available) */
  addedHtml?: string
  /** Starting character offset where new content begins */
  startOffset: number
}

/**
 * Reveal hint for animation control.
 *
 * Processors can emit reveal hints to suggest how React should
 * animate the appearance of content.
 */
export interface RevealHint {
  /** How to reveal the content */
  type: 'instant' | 'character' | 'word' | 'line'
  /** Suggested duration in ms (for non-instant reveals) */
  duration?: number
  /** Whether this is the final chunk */
  isComplete?: boolean
}

// =============================================================================
// TOKEN USAGE
// =============================================================================

/**
 * Token usage statistics from the LLM.
 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

// =============================================================================
// TOOL CALL INFO
// =============================================================================

/**
 * Information about a tool call (normalized format).
 */
export interface ToolCallInfo {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * Result from server-side tool execution.
 */
export interface ServerToolResult {
  id: string
  name: string
  content: string
  isError: boolean
}
