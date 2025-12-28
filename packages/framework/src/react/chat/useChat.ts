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
 * ## Plugin-Based API
 *
 * ```tsx
 * import { useChat } from '@tanstack/framework/react/chat'
 * import { markdownPlugin, shikiPlugin } from '@tanstack/framework/react/chat/plugins'
 *
 * function ChatUI() {
 *   const { messages, isStreaming, send } = useChat({
 *     plugins: [markdownPlugin, shikiPlugin]
 *   })
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
import { run } from 'effection'
import { useChatSession, type UseChatSessionOptions, type UseChatSessionReturn } from './useChatSession'
import { renderingBufferTransform } from './core/rendering-buffer'
import { markdown } from './processors'
import { paragraph, line, sentence, codeFence } from './settlers'
import type { SettleMeta, RenderDelta, RevealHint, SettlerFactory } from './types'
import type { ProcessorPlugin, SettlerPreference } from './plugins/types'
import { resolvePlugins, preloadPlugins, arePluginsReady } from './plugins/loader'
import { createProcessorChain } from './processor-chain'
// New pipeline imports
import type { PipelineConfig, ProcessorFactory as PipelineProcessorFactory } from './pipeline/types'
import {
  createPipelineTransform,
  createCodeFenceSettler,
  createMarkdownProcessor,
  createShikiProcessor,
  createMermaidProcessor,
  preloadShiki,
  preloadMermaid,
  isShikiReady,
  isMermaidReady,
} from './pipeline'

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
/**
 * Pipeline preset names for easy configuration.
 */
export type PipelinePreset = 'markdown' | 'shiki' | 'mermaid' | 'full'

export interface UseChatOptions extends Omit<UseChatSessionOptions, 'transforms'> {
  /**
   * Plugins for the streaming pipeline (legacy plugin system).
   *
   * Plugins are resolved in dependency order and combined into a single
   * transform. The settler is negotiated from all plugins (most specific wins).
   *
   * If not provided, a default markdown plugin is used.
   *
   * @example
   * ```typescript
   * import { markdownPlugin, shikiPlugin, mermaidPlugin } from '@tanstack/framework/react/chat/plugins'
   *
   * useChat({
   *   plugins: [markdownPlugin, shikiPlugin, mermaidPlugin]
   * })
   * ```
   */
  plugins?: ProcessorPlugin[]

  /**
   * Use the new Frame-based pipeline system.
   *
   * The pipeline uses immutable Frame snapshots for cleaner rendering:
   * - Better progressive enhancement (quick → full rendering)
   * - No content duplication bugs
   * - Easier debugging via trace
   *
   * Can be a preset name or a custom PipelineConfig:
   * - 'markdown': Basic markdown parsing
   * - 'shiki': Markdown + Shiki syntax highlighting
   * - 'mermaid': Markdown + Mermaid diagram rendering
   * - 'full': Markdown + Shiki + Mermaid
   *
   * @example
   * ```typescript
   * // Use a preset
   * useChat({ pipeline: 'full' })
   *
   * // Or custom config
   * useChat({
   *   pipeline: {
   *     settler: createCodeFenceSettler,
   *     processors: [createMarkdownProcessor, createShikiProcessor],
   *   }
   * })
   * ```
   */
  pipeline?: PipelinePreset | PipelineConfig

  /**
   * Custom transforms for the streaming pipeline.
   *
   * If provided, this overrides the `plugins` and `pipeline` options.
   * For most use cases, prefer using `pipeline` or `plugins` instead.
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
   * Whether all plugin assets are ready.
   *
   * This is true when all plugins with async assets (like Shiki highlighters)
   * have finished loading. You can use this to show a loading indicator.
   *
   * Note: Streaming works even before plugins are ready - the quick pass
   * provides immediate feedback while full rendering loads in the background.
   */
  pluginsReady: boolean

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

// --- Settler Resolution ---

/**
 * Get the settler factory for a given settler preference.
 */
function getSettlerFactory(preference: SettlerPreference): SettlerFactory {
  switch (preference) {
    case 'codeFence':
      return codeFence
    case 'line':
      return line
    case 'sentence':
      return sentence
    case 'paragraph':
    default:
      return paragraph
  }
}

// --- Default Transforms ---

const defaultTransforms = [
  renderingBufferTransform({
    processor: markdown,
  })
]

// --- Pipeline Presets ---

/**
 * Resolve a pipeline preset to a PipelineConfig.
 */
function resolvePipelinePreset(preset: PipelinePreset): PipelineConfig {
  switch (preset) {
    case 'markdown':
      return {
        settler: createCodeFenceSettler,
        processors: [createMarkdownProcessor],
      }
    case 'shiki':
      return {
        settler: createCodeFenceSettler,
        processors: [createMarkdownProcessor, createShikiProcessor],
      }
    case 'mermaid':
      return {
        settler: createCodeFenceSettler,
        processors: [createMarkdownProcessor, createMermaidProcessor],
      }
    case 'full':
      return {
        settler: createCodeFenceSettler,
        processors: [createMarkdownProcessor, createShikiProcessor, createMermaidProcessor],
      }
  }
}

/**
 * Check if a pipeline config uses Shiki.
 */
function pipelineUsesShiki(config: PipelineConfig): boolean {
  return config.processors.some(p => p === createShikiProcessor)
}

/**
 * Check if a pipeline config uses Mermaid.
 */
function pipelineUsesMermaid(config: PipelineConfig): boolean {
  return config.processors.some(p => p === createMermaidProcessor)
}

// --- Hook Implementation ---

/**
 * High-level chat hook with simple Message[] interface.
 *
 * Supports a plugin-based API for easy configuration:
 *
 * @example
 * ```tsx
 * import { markdownPlugin, shikiPlugin } from '@tanstack/framework/react/chat/plugins'
 *
 * const { messages, isStreaming, send } = useChat({
 *   plugins: [markdownPlugin, shikiPlugin]
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
  const { plugins, pipeline, transforms: customTransforms, ...sessionOptions } = options

  // Resolve pipeline config if provided
  const pipelineConfig = useMemo(() => {
    if (!pipeline) return null
    if (typeof pipeline === 'string') {
      return resolvePipelinePreset(pipeline)
    }
    return pipeline
  }, [pipeline])

  // Resolve plugins/pipeline into transforms (memoized)
  const transforms = useMemo(() => {
    // If custom transforms provided, use them directly
    if (customTransforms) {
      return customTransforms
    }

    // If pipeline is configured, use the new Frame-based system
    if (pipelineConfig) {
      return [createPipelineTransform(pipelineConfig)]
    }

    // If no plugins provided, use default markdown transform
    if (!plugins || plugins.length === 0) {
      return defaultTransforms
    }

    // Resolve plugins to get settler and processor chain (legacy system)
    const resolved = resolvePlugins(plugins)
    const settlerFactory = getSettlerFactory(resolved.settler)
    const processorChain = createProcessorChain(resolved.processors)

    return [
      renderingBufferTransform({
        settler: settlerFactory,
        processor: processorChain,
      })
    ]
  }, [plugins, pipelineConfig, customTransforms])

  // Track whether plugins/pipeline assets are ready
  const [pluginsReady, setPluginsReady] = useState(() => {
    // Pipeline mode: check Shiki/Mermaid readiness
    if (pipelineConfig) {
      const shikiNeeded = pipelineUsesShiki(pipelineConfig)
      const mermaidNeeded = pipelineUsesMermaid(pipelineConfig)
      return (!shikiNeeded || isShikiReady()) && (!mermaidNeeded || isMermaidReady())
    }
    // Legacy plugin mode
    if (!plugins || plugins.length === 0) return true
    const resolved = resolvePlugins(plugins)
    return arePluginsReady(resolved.plugins)
  })

  // Eager preload of plugin/pipeline assets on mount
  const preloadStarted = useRef(false)
  useEffect(() => {
    if (preloadStarted.current) {
      return
    }

    // Pipeline mode: preload Shiki/Mermaid
    if (pipelineConfig) {
      const shikiNeeded = pipelineUsesShiki(pipelineConfig)
      const mermaidNeeded = pipelineUsesMermaid(pipelineConfig)

      if (!shikiNeeded && !mermaidNeeded) {
        setPluginsReady(true)
        return
      }

      // Check if already ready
      if ((!shikiNeeded || isShikiReady()) && (!mermaidNeeded || isMermaidReady())) {
        setPluginsReady(true)
        return
      }

      preloadStarted.current = true

      // Preload in background
      run(function* () {
        if (shikiNeeded && !isShikiReady()) {
          yield* preloadShiki()
        }
        if (mermaidNeeded && !isMermaidReady()) {
          yield* preloadMermaid()
        }
        setPluginsReady(true)
      }).catch((err) => {
        console.warn('[useChat] Pipeline preload error:', err)
        setPluginsReady(true)
      })
      return
    }

    // Legacy plugin mode
    if (!plugins || plugins.length === 0) {
      setPluginsReady(true)
      return
    }

    preloadStarted.current = true
    const resolved = resolvePlugins(plugins)

    // Check if already ready
    if (arePluginsReady(resolved.plugins)) {
      setPluginsReady(true)
      return
    }

    // Start preloading in background
    run(function* () {
      yield* preloadPlugins(resolved.plugins)
      setPluginsReady(true)
    }).catch((err) => {
      // Preload errors are non-fatal, just log them
      console.warn('[useChat] Plugin preload error:', err)
      // Still mark as ready so we don't block forever
      setPluginsReady(true)
    })
  }, [plugins, pipelineConfig])

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
    pluginsReady,
    send,
    abort,
    reset,
    error: state.error,
    session,
  }
}
