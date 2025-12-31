/**
 * lib/chat/types/chat-message.ts
 *
 * Framework-agnostic message types for chat UIs.
 *
 * These types use generics to allow different UI frameworks to specify their
 * component type (React.ComponentType, Vue Component, Svelte Component, etc.)
 *
 * @example React
 * ```tsx
 * import type { ChatMessage } from '@tanstack/framework/lib/chat'
 * type ReactChatMessage = ChatMessage<React.ComponentType<any>>
 * ```
 *
 * @example Vue
 * ```ts
 * import type { ChatMessage } from '@tanstack/framework/lib/chat'
 * import type { Component } from 'vue'
 * type VueChatMessage = ChatMessage<Component>
 * ```
 */

import type { RenderDelta, RevealHint, ContentMetadata } from '../core-types'

// =============================================================================
// EMISSION TYPES
// =============================================================================

/**
 * A tool emission - an interactive UI component rendered by a tool via ctx.render().
 *
 * When a tool calls `yield* ctx.render(Component, props)`, it creates an emission
 * that the UI should render inline. The user interacts with it, and the tool
 * receives the response to continue execution.
 *
 * @typeParam TComponent - The UI framework's component type (e.g., React.ComponentType)
 */
export interface ChatEmission<TComponent = unknown> {
  /** Unique emission ID */
  id: string
  /** Current status */
  status: 'pending' | 'complete'
  /** The component to render */
  component: TComponent
  /** Props to pass to the component (excluding framework-specific props like onRespond) */
  props: Record<string, unknown>
  /** Response value once user completes interaction */
  response?: unknown
  /** Callback to complete the emission - only present when pending */
  onRespond?: (value: unknown) => void
}

// =============================================================================
// TOOL CALL TYPES
// =============================================================================

/**
 * A tool call made by the assistant.
 *
 * When the LLM decides to use a tool, it creates a tool call. The tool executes
 * and may emit interactive UI components (emissions) during execution.
 *
 * @typeParam TComponent - The UI framework's component type
 */
export interface ChatToolCall<TComponent = unknown> {
  /** Tool call ID */
  id: string
  /** Tool name */
  name: string
  /** Arguments passed to the tool */
  arguments: unknown
  /** Current execution state */
  state: 'pending' | 'running' | 'complete' | 'error'
  /** Tool result (when complete) */
  result?: unknown
  /** Error message (when error) */
  error?: string
  /** Interactive emissions from this tool (e.g., ctx.render() components) */
  emissions: ChatEmission<TComponent>[]
}

// =============================================================================
// MESSAGE TYPES
// =============================================================================

/**
 * A chat message with resolved content.
 *
 * This is the primary type for rendering chat UI. It includes:
 * - Text content (raw and HTML)
 * - Tool calls made during this assistant turn
 * - Interactive emissions from those tool calls
 *
 * @typeParam TComponent - The UI framework's component type
 *
 * @example
 * ```tsx
 * function Message({ message }: { message: ChatMessage<React.ComponentType> }) {
 *   return (
 *     <div>
 *       {message.toolCalls?.map(tc => (
 *         <div key={tc.id}>
 *           {tc.emissions.map(emission => (
 *             <emission.component
 *               key={emission.id}
 *               {...emission.props}
 *               onRespond={emission.onRespond}
 *               disabled={emission.status !== 'pending'}
 *               response={emission.response}
 *             />
 *           ))}
 *         </div>
 *       ))}
 *       {message.html ? (
 *         <div dangerouslySetInnerHTML={{ __html: message.html }} />
 *       ) : message.content}
 *     </div>
 *   )
 * }
 * ```
 */
export interface ChatMessage<TComponent = unknown> {
  /** Unique message ID */
  id: string
  /** Message role: 'user', 'assistant', or 'system' */
  role: 'user' | 'assistant' | 'system'
  /** Raw text content */
  content: string
  /** Rendered HTML (if available) */
  html?: string
  /** Whether this message is currently streaming */
  isStreaming?: boolean
  /** Timestamp when created */
  createdAt?: Date
  /** Tool calls made during this assistant turn (assistant messages only) */
  toolCalls?: ChatToolCall<TComponent>[]
}

// =============================================================================
// STREAMING MESSAGE TYPES
// =============================================================================

/**
 * Streaming message state - the message currently being streamed.
 *
 * This is a special view that includes animation-ready data
 * for smooth rendering during streaming.
 *
 * @typeParam TComponent - The UI framework's component type (for toolCalls)
 */
export interface StreamingMessage<TComponent = unknown> {
  /** Role is always 'assistant' for streaming messages */
  role: 'assistant'
  /** Current accumulated content */
  content: string
  /** Current accumulated HTML */
  html?: string
  /** Delta from last update (for animation) */
  delta?: RenderDelta
  /** Reveal hint for animation control */
  revealHint?: RevealHint
  /** Metadata from processor (e.g., code fence info) */
  meta?: ContentMetadata
  /** Timestamp of last update */
  timestamp?: number
  /** Tool calls in progress during streaming */
  toolCalls?: ChatToolCall<TComponent>[]
}
