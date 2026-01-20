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
 * ## Pipeline API
 *
 * ```tsx
 * import { useChat } from '@sweatpants/framework/react/chat'
 *
 * function ChatUI() {
 *   // Use a preset for common setups
 *   const { messages, isStreaming, send } = useChat({
 *     pipeline: 'full'  // markdown + shiki + mermaid + math
 *   })
 *
 *   // Or specify processors explicitly
 *   // import { markdown, shiki } from '@sweatpants/framework/react/chat/pipeline'
 *   // const { messages, send } = useChat({
 *   //   pipeline: { processors: [markdown, shiki] }
 *   // })
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
import { useMemo, useEffect, useRef, useState } from 'react'
import { run, call } from 'effection'
import { useChatSession, type UseChatSessionOptions, type UseChatSessionReturn } from './useChatSession.ts'
import { deriveMessages, deriveStreamingMessage } from '../../lib/chat/state/derive-messages.ts'
import type {
  ChatMessage as BaseChatMessage,
  ChatToolCall as BaseChatToolCall,
  ChatEmission as BaseChatEmission,
  StreamingMessage as BaseStreamingMessage,
} from '../../lib/chat/types/chat-message.ts'
import type { PipelineConfig, Processor } from './pipeline/types.ts'
import {
  createPipelineTransform,
  // Built-in processors
  markdown as markdownProcessor,
  shiki as shikiProcessor,
  mermaid as mermaidProcessor,
  math as mathProcessor,
  // Preload helpers
  preloadShiki,
  preloadMermaid,
  preloadMath,
  isShikiReady,
  isMermaidReady,
  isMathReady,
} from './pipeline/index.ts'

// --- React-specific type aliases ---

/**
 * A tool emission with React component type.
 */
export type ChatEmission = BaseChatEmission<React.ComponentType<any>>

/**
 * A tool call with React component type for emissions.
 */
export type ChatToolCall = BaseChatToolCall<React.ComponentType<any>>

/**
 * A chat message with React component type for emissions.
 */
export type ChatMessage = BaseChatMessage<React.ComponentType<any>>

/**
 * Streaming message with React component type for tool calls.
 */
export type StreamingMessage = BaseStreamingMessage<React.ComponentType<any>>

/**
 * Pipeline preset names for easy configuration.
 */
export type PipelinePreset = 'markdown' | 'shiki' | 'mermaid' | 'math' | 'full'

/**
 * Options for useChat hook.
 */
export interface UseChatOptions extends Omit<UseChatSessionOptions, 'transforms'> {
  /**
   * Configure the streaming pipeline.
   *
   * The pipeline uses immutable Frame snapshots for clean rendering:
   * - Progressive enhancement (quick → full rendering)
   * - No content duplication bugs
   * - Automatic dependency resolution
   *
   * Can be a preset name or a custom PipelineConfig:
   * - 'markdown': Basic markdown parsing
   * - 'shiki': Markdown + Shiki syntax highlighting
   * - 'mermaid': Markdown + Mermaid diagram rendering
   * - 'math': Markdown + KaTeX math rendering
   * - 'full': Markdown + Shiki + Mermaid + Math
   *
   * @example
   * ```typescript
   * // Use a preset
   * useChat({ pipeline: 'full' })
   *
   * // Or with specific processors (dependencies auto-resolved)
   * import { markdown, shiki } from '@sweatpants/framework/react/chat/pipeline'
   * useChat({
   *   pipeline: { processors: [markdown, shiki] }
   * })
   * ```
   *
   * @default 'markdown'
   */
  pipeline?: PipelinePreset | PipelineConfig

  /**
   * Custom transforms for the streaming pipeline.
   *
   * If provided, this overrides the `pipeline` option.
   * For most use cases, prefer using `pipeline` instead.
   *
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
   * Whether all pipeline assets are ready.
   *
   * This is true when all processors with async assets (like Shiki highlighters)
   * have finished loading. You can use this to show a loading indicator.
   *
   * Note: Streaming works even before assets are ready - the quick pass
   * provides immediate feedback while full rendering loads in the background.
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
   *
   * Use this to access buffers, tool approvals, handoffs, etc.
   */
  session: UseChatSessionReturn
}

// --- Pipeline Presets ---

/**
 * Resolve a pipeline preset to a PipelineConfig.
 */
function resolvePipelinePreset(preset: PipelinePreset): PipelineConfig {
  switch (preset) {
    case 'markdown':
      return {
        processors: [markdownProcessor],
      }
    case 'shiki':
      return {
        processors: [markdownProcessor, shikiProcessor],
      }
    case 'mermaid':
      return {
        processors: [markdownProcessor, mermaidProcessor],
      }
    case 'math':
      return {
        processors: [markdownProcessor, mathProcessor],
      }
    case 'full':
      return {
        processors: [markdownProcessor, shikiProcessor, mermaidProcessor, mathProcessor],
      }
  }
}

/**
 * Get the processors from a pipeline config.
 */
function getProcessors(config: PipelineConfig): readonly Processor[] {
  if (typeof config.processors === 'string') {
    // It's a preset - resolve it
    const resolved = resolvePipelinePreset(config.processors as PipelinePreset)
    return resolved.processors as readonly Processor[]
  }
  return config.processors as readonly Processor[]
}

/**
 * Check if a pipeline config uses Shiki.
 */
function pipelineUsesShiki(config: PipelineConfig): boolean {
  const processors = getProcessors(config)
  return processors.some(p => p.name === 'shiki')
}

/**
 * Check if a pipeline config uses Mermaid.
 */
function pipelineUsesMermaid(config: PipelineConfig): boolean {
  const processors = getProcessors(config)
  return processors.some(p => p.name === 'mermaid')
}

/**
 * Check if a pipeline config uses Math.
 */
function pipelineUsesMath(config: PipelineConfig): boolean {
  const processors = getProcessors(config)
  return processors.some(p => p.name === 'math')
}

// --- Hook Implementation ---

/**
 * High-level chat hook with simple Message[] interface.
 *
 * @example
 * ```tsx
 * const { messages, isStreaming, send } = useChat({
 *   pipeline: 'full'  // markdown + shiki + mermaid + math
 * })
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
 *
 * For advanced use cases (custom transforms, tool approvals, etc.),
 * use useChatSession directly.
 */
export function useChat(options: UseChatOptions = {}): UseChatReturn {
  const { pipeline = 'markdown', transforms: customTransforms, ...sessionOptions } = options

  // Resolve pipeline config
  const pipelineConfig = useMemo(() => {
    if (typeof pipeline === 'string') {
      return resolvePipelinePreset(pipeline)
    }
    return pipeline
  }, [pipeline])

  // Resolve pipeline into transforms (memoized)
  const transforms = useMemo(() => {
    // If custom transforms provided, use them directly
    if (customTransforms) {
      return customTransforms
    }

    // Use the pipeline transform
    return [createPipelineTransform(pipelineConfig)]
  }, [pipelineConfig, customTransforms])

  // Track whether pipeline assets are ready
  const [pipelineReady, setPipelineReady] = useState(() => {
    const shikiNeeded = pipelineUsesShiki(pipelineConfig)
    const mermaidNeeded = pipelineUsesMermaid(pipelineConfig)
    const mathNeeded = pipelineUsesMath(pipelineConfig)
    return (
      (!shikiNeeded || isShikiReady()) &&
      (!mermaidNeeded || isMermaidReady()) &&
      (!mathNeeded || isMathReady())
    )
  })

  // Eager preload of pipeline assets on mount
  const preloadStarted = useRef(false)
  useEffect(() => {
    if (preloadStarted.current) {
      return
    }

    const shikiNeeded = pipelineUsesShiki(pipelineConfig)
    const mermaidNeeded = pipelineUsesMermaid(pipelineConfig)
    const mathNeeded = pipelineUsesMath(pipelineConfig)

    if (!shikiNeeded && !mermaidNeeded && !mathNeeded) {
      setPipelineReady(true)
      return
    }

    // Check if already ready
    if (
      (!shikiNeeded || isShikiReady()) &&
      (!mermaidNeeded || isMermaidReady()) &&
      (!mathNeeded || isMathReady())
    ) {
      setPipelineReady(true)
      return
    }

    preloadStarted.current = true

    // Preload in background
    run(function* () {
      if (shikiNeeded && !isShikiReady()) {
        yield* call(() => preloadShiki())
      }
      if (mermaidNeeded && !isMermaidReady()) {
        yield* preloadMermaid()
      }
      if (mathNeeded && !isMathReady()) {
        yield* preloadMath()
      }
      setPipelineReady(true)
    }).catch((err) => {
      console.warn('[useChat] Pipeline preload error:', err)
      setPipelineReady(true)
    })
  }, [pipelineConfig])

  // Use the low-level session hook
  const session = useChatSession({
    ...sessionOptions,
    transforms,
  })

  const { state, send, abort, reset, toolEmissions } = session

  // Component extractor for React - extracts the _component from emission payload
  const extractComponent = (emission: { payload: { _component?: React.ComponentType<any> } }) =>
    emission.payload._component

  // Build options for deriveMessages (toolEmissions are React-local state)
  const deriveOptions = useMemo(() => ({
    toolEmissions: toolEmissions.reduce((acc, tracking) => {
      acc[tracking.callId] = tracking
      return acc
    }, {} as Record<string, typeof toolEmissions[0]>),
    pendingElicits: state.pendingElicits,
  }), [toolEmissions, state.pendingElicits])

  // Derive messages using the framework-agnostic derivation function
  const messages: ChatMessage[] = useMemo(
    () => deriveMessages<React.ComponentType<any>>(state, deriveOptions, extractComponent),
    [state, deriveOptions]
  )

  // Derive streaming message using the framework-agnostic derivation function
  const streamingMessage: StreamingMessage | null = useMemo(
    () => deriveStreamingMessage<React.ComponentType<any>>(state, deriveOptions, extractComponent),
    [state, deriveOptions]
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
  }
}
