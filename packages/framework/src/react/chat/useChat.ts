/**
 * useChat.ts
 *
 * High-level React hook for chat that abstracts away buffer complexity.
 *
 * This hook provides a simple Message[] interface for most use cases,
 * while useChatSession provides full access to buffers and internals
 * for advanced scenarios.
 *
 * ## Two-Level API
 *
 * - `useChat`: Simple API - just messages, send, and streaming state
 * - `useChatSession`: Advanced API - full access to buffers, transforms, patches
 *
 * ## Usage
 *
 * ```tsx
 * import { useChat } from '@tanstack/framework/react/chat'
 *
 * function ChatUI() {
 *   const { messages, isStreaming, send } = useChat()
 *
 *   return (
 *     <div>
 *       {messages.map(msg => (
 *         <div key={msg.id}>
 *           <strong>{msg.role}:</strong>
 *           {msg.html ? (
 *             <div dangerouslySetInnerHTML={{ __html: msg.html }} />
 *           ) : (
 *             <div>{msg.content}</div>
 *           )}
 *         </div>
 *       ))}
 *       {isStreaming && <div>Typing...</div>}
 *     </div>
 *   )
 * }
 * ```
 */
import { useMemo } from 'react'
import { useChatSession, type UseChatSessionOptions, type UseChatSessionReturn } from './useChatSession'
import { tripleBufferTransform } from './tripleBuffer'
import { markdown } from './processors'
import type { SettleMeta, RenderDelta, RevealHint } from './types'

// --- Types ---

/**
 * A chat message with resolved content.
 *
 * This is a simplified view of a message that includes both
 * raw content and rendered HTML when available.
 */
export interface ChatMessage {
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
}

/**
 * Streaming message state - the message currently being streamed.
 *
 * This is a special view that includes animation-ready data
 * for smooth rendering during streaming.
 */
export interface StreamingMessage {
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
  /** Metadata from settler (e.g., code fence info) */
  meta?: SettleMeta
  /** Timestamp of last update */
  timestamp?: number
}

/**
 * Options for useChat hook.
 *
 * Most options are inherited from useChatSession, but some defaults differ.
 */
export interface UseChatOptions extends Omit<UseChatSessionOptions, 'transforms'> {
  /**
   * Custom transforms for the streaming pipeline.
   *
   * If not provided, a default markdown pipeline is used.
   * For advanced customization, use useChatSession directly.
   */
  transforms?: UseChatSessionOptions['transforms']
}

/**
 * Return value from useChat hook.
 */
export interface UseChatReturn {
  /**
   * All messages in the conversation.
   *
   * This includes both completed messages and the current streaming message
   * (if any). The streaming message is included at the end with isStreaming=true.
   */
  messages: ChatMessage[]

  /**
   * The currently streaming message, if any.
   *
   * This provides more detailed streaming state including delta and animation hints.
   * For most UIs, just use `messages` which includes the streaming message.
   */
  streamingMessage: StreamingMessage | null

  /**
   * Whether a message is currently being streamed.
   */
  isStreaming: boolean

  /**
   * Send a message.
   */
  send: (content: string) => void

  /**
   * Abort the current streaming message.
   */
  abort: () => void

  /**
   * Reset the conversation (clear all messages).
   */
  reset: () => void

  /**
   * Error message, if any.
   */
  error: string | null

  /**
   * Access to the underlying session for advanced use cases.
   *
   * Use this to access buffers, tool approvals, handoffs, etc.
   */
  session: UseChatSessionReturn
}

// --- Default Transforms ---

const defaultTransforms = [
  tripleBufferTransform({
    processor: markdown,
  })
]

// --- Hook Implementation ---

/**
 * High-level chat hook with simple Message[] interface.
 *
 * For advanced use cases (custom transforms, tool approvals, etc.),
 * use useChatSession directly.
 *
 * @example
 * ```tsx
 * const { messages, isStreaming, send } = useChat()
 *
 * // Messages include both completed and streaming messages
 * messages.map(msg => (
 *   <div key={msg.id}>
 *     {msg.html ? (
 *       <div dangerouslySetInnerHTML={{ __html: msg.html }} />
 *     ) : msg.content}
 *   </div>
 * ))
 * ```
 */
export function useChat(options: UseChatOptions = {}): UseChatReturn {
  const { transforms = defaultTransforms, ...sessionOptions } = options

  // Use the low-level session hook
  const session = useChatSession({
    ...sessionOptions,
    transforms,
  })

  const { state, send, abort, reset } = session

  // Transform completed messages to ChatMessage format
  const completedMessages: ChatMessage[] = useMemo(() => {
    return state.messages.map((msg): ChatMessage => {
      const rendered = msg.id ? state.rendered[msg.id] : null
      return {
        id: msg.id ?? `msg-${Date.now()}`,
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
        ...(rendered?.output && { html: rendered.output }),
        isStreaming: false,
      }
    })
  }, [state.messages, state.rendered])

  // Create streaming message from buffer state
  const streamingMessage: StreamingMessage | null = useMemo(() => {
    if (!state.isStreaming) return null

    const renderable = state.buffer.renderable
    if (!renderable) {
      // Fallback to settled content if no renderable buffer
      return {
        role: 'assistant' as const,
        content: state.buffer.settled,
        ...(state.buffer.settledHtml && { html: state.buffer.settledHtml }),
      }
    }

    return {
      role: 'assistant' as const,
      content: renderable.next,
      ...(renderable.html && { html: renderable.html }),
      ...(renderable.delta && { delta: renderable.delta }),
      ...(renderable.revealHint && { revealHint: renderable.revealHint }),
      ...(renderable.meta && { meta: renderable.meta }),
      ...(renderable.timestamp && { timestamp: renderable.timestamp }),
    }
  }, [state.isStreaming, state.buffer])

  // Combine completed messages with streaming message
  const messages: ChatMessage[] = useMemo(() => {
    if (!streamingMessage) return completedMessages

    const streamingChatMessage: ChatMessage = {
      id: 'streaming',
      role: 'assistant',
      content: streamingMessage.content,
      ...(streamingMessage.html && { html: streamingMessage.html }),
      isStreaming: true,
    }

    return [...completedMessages, streamingChatMessage]
  }, [completedMessages, streamingMessage])

  return {
    messages,
    streamingMessage,
    isStreaming: state.isStreaming,
    send,
    abort,
    reset,
    error: state.error,
    session,
  }
}
