/**
 * useInkChat.ts
 *
 * High-level Ink hook for chat that mirrors the React useChat hook.
 *
 * This hook provides a simple Message[] interface for Ink (terminal) UIs.
 * It's essentially the same as the React hook but:
 * - Uses terminal-friendly pipeline defaults
 * - Supports customFetch for in-process handlers
 * - Returns Frame-based content for ANSI rendering
 *
 * ## Usage
 *
 * ```tsx
 * import { useInkChat } from '@sweatpants/framework/ink/chat'
 * import { terminalMarkdown, terminalCode } from './pipeline'
 *
 * function ChatUI() {
 *   const { messages, isStreaming, send } = useInkChat({
 *     pipeline: { processors: [terminalMarkdown, terminalCode] },
 *     customFetch: devServer.fetch,
 *   })
 *
 *   return (
 *     <Box flexDirection="column">
 *       {messages.map(msg => (
 *         <MessageView key={msg.id} message={msg} />
 *       ))}
 *       {isStreaming && <Text>Thinking...</Text>}
 *     </Box>
 *   )
 * }
 * ```
 */
import { useMemo, useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { useChatSession, type UseChatSessionOptions, type UseChatSessionReturn } from '../../react/chat/useChatSession.ts'
import { deriveMessages, deriveStreamingMessage } from '../../lib/chat/state/derive-messages.ts'
import type { PipelineConfig, Processor } from '../../react/chat/pipeline/types.ts'
import { createPipelineTransform } from '../../react/chat/pipeline/index.ts'
import { useInkChatConfig, type CustomFetchFn } from './InkChatProvider.tsx'
import type {
  InkChatMessage,
  InkStreamingMessage,
  PendingClientToolState,
  PendingHandoff,
  ToolEmissionTrackingState,
} from './types.ts'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for useInkChat hook.
 */
export interface UseInkChatOptions extends Omit<UseChatSessionOptions, 'transforms'> {
  /**
   * Custom fetch function.
   * When provided, this is used instead of the standard fetch.
   * Useful for in-process handlers (like dev servers with HMR).
   */
  customFetch?: CustomFetchFn

  /**
   * Configure the streaming pipeline.
   *
   * For terminal output, provide terminal-specific processors:
   *
   * @example
   * ```typescript
   * import { terminalMarkdown, terminalCode } from './pipeline'
   *
   * useInkChat({
   *   pipeline: { processors: [terminalMarkdown, terminalCode] }
   * })
   * ```
   *
   * If not provided, raw content is passed through without processing.
   */
  pipeline?: PipelineConfig
}

/**
 * Return value from useInkChat hook.
 */
export interface UseInkChatReturn {
  /**
   * All messages in the conversation.
   *
   * This includes both completed messages and the current streaming message
   * (if any). The streaming message is included at the end with isStreaming=true.
   */
  messages: InkChatMessage[]

  /**
   * The currently streaming message, if any.
   *
   * This provides more detailed streaming state including parts and active part.
   * For most UIs, just use `messages` which includes the streaming message.
   */
  streamingMessage: InkStreamingMessage | null

  /**
   * Whether a message is currently being streamed.
   */
  isStreaming: boolean

  /**
   * Whether all pipeline assets are ready.
   */
  pipelineReady: boolean

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
   */
  session: UseChatSessionReturn

  // --- Tool APIs ---

  /**
   * Pending client tools awaiting approval.
   */
  pendingApprovals: PendingClientToolState[]

  /**
   * Approve a pending client tool.
   */
  approve: (callId: string) => void

  /**
   * Deny a pending client tool.
   */
  deny: (callId: string, reason?: string) => void

  /**
   * Pending tool handoffs that need UI handling.
   */
  pendingHandoffs: PendingHandoff[]

  /**
   * Respond to a pending handoff with client output.
   */
  respondToHandoff: (callId: string, output: unknown) => void

  /**
   * Active tool emissions from tools using ctx.render() pattern.
   */
  toolEmissions: ToolEmissionTrackingState[]

  /**
   * Respond to a pending emission with user input.
   */
  respondToEmission: (callId: string, emissionId: string, response: unknown) => void
}

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

/**
 * High-level chat hook for Ink applications.
 *
 * This is the terminal equivalent of the React `useChat` hook. It provides
 * a simple Message[] interface while handling all the complexity of streaming,
 * pipeline processing, and tool execution.
 *
 * @example
 * ```tsx
 * import { useInkChat } from '@sweatpants/framework/ink/chat'
 * import { Box, Text } from 'ink'
 *
 * function App() {
 *   const { messages, isStreaming, send } = useInkChat({
 *     customFetch: devServer.fetch,
 *     pipeline: { processors: [terminalMarkdown, terminalCode] },
 *   })
 *
 *   return (
 *     <Box flexDirection="column">
 *       {messages.map(msg => (
 *         <Box key={msg.id}>
 *           <Text bold>{msg.role}: </Text>
 *           <Text>{msg.content}</Text>
 *         </Box>
 *       ))}
 *       {isStreaming && <Text dimColor>Thinking...</Text>}
 *     </Box>
 *   )
 * }
 * ```
 */
export function useInkChat(options: UseInkChatOptions = {}): UseInkChatReturn {
  const config = useInkChatConfig()
  const { pipeline, customFetch, ...sessionOptions } = options

  // Resolve customFetch: option > context
  // TODO: Implement customFetch support in the session layer
  // For now, customFetch is available via the config but not yet wired up
  void (customFetch ?? config.customFetch)

  // Create transforms from pipeline config (memoized)
  const transforms = useMemo(() => {
    if (!pipeline) {
      // No pipeline - passthrough
      return []
    }
    return [createPipelineTransform(pipeline)]
  }, [pipeline])

  // Track pipeline readiness
  const [pipelineReady, setPipelineReady] = useState(() => {
    if (!pipeline) return true
    const processors = pipeline.processors as readonly Processor[]
    return processors.every(p => p.isReady?.() ?? true)
  })

  // Check readiness periodically if not ready
  useEffect(() => {
    if (pipelineReady || !pipeline) return

    const processors = pipeline.processors as readonly Processor[]
    const checkReady = () => {
      if (processors.every(p => p.isReady?.() ?? true)) {
        setPipelineReady(true)
      }
    }

    // Check immediately
    checkReady()

    // Check again after a delay (for async processors)
    const timer = setInterval(checkReady, 100)
    return () => clearInterval(timer)
  }, [pipeline, pipelineReady])

  // Merge options with context config
  const mergedOptions: UseChatSessionOptions = {
    ...sessionOptions,
    baseUrl: sessionOptions.baseUrl ?? config.baseUrl,
    transforms,
  }

  // Use the low-level session hook
  const session = useChatSession(mergedOptions)

  const { state, send, abort, reset } = session

  // Component extractor for Ink (same as React since Ink uses React)
  const extractComponent = (emission: { payload: { _component?: ComponentType<any> } }) =>
    emission.payload._component

  // Derive messages using the framework-agnostic derivation function
  const messages: InkChatMessage[] = useMemo(
    () => deriveMessages<ComponentType<any>>(state, extractComponent),
    [state]
  )

  // Derive streaming message
  const streamingMessage: InkStreamingMessage | null = useMemo(
    () => deriveStreamingMessage<ComponentType<any>>(state, extractComponent),
    [state]
  )

  return {
    messages,
    streamingMessage,
    isStreaming: state.isStreaming,
    pipelineReady,
    send,
    abort,
    reset,
    error: state.error,
    session,
    // Tool APIs (pass through from session)
    pendingApprovals: session.pendingApprovals,
    approve: session.approve,
    deny: session.deny,
    pendingHandoffs: session.pendingHandoffs,
    respondToHandoff: session.respondToHandoff,
    toolEmissions: session.toolEmissions,
    respondToEmission: session.respondToEmission,
  }
}
