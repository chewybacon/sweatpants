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
 * import { useChat } from '@tanstack/framework/react/chat'
 *
 * function ChatUI() {
 *   // Use a preset for common setups
 *   const { messages, isStreaming, send } = useChat({
 *     pipeline: 'full'  // markdown + shiki + mermaid + math
 *   })
 *
 *   // Or specify processors explicitly
 *   // import { markdown, shiki } from '@tanstack/framework/react/chat/pipeline'
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
import { useChatSession, type UseChatSessionOptions, type UseChatSessionReturn } from './useChatSession'
import type { RenderDelta, RevealHint, ContentMetadata, ToolEmissionState } from './types'
import type { PipelineConfig, Processor } from './pipeline/types'
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
} from './pipeline'

// --- Types ---

/**
 * A tool emission - an interactive UI component rendered by a tool via ctx.render().
 * 
 * When a tool calls `yield* ctx.render(Component, props)`, it creates an emission
 * that the UI should render inline. The user interacts with it, and the tool
 * receives the response to continue execution.
 */
export interface ChatEmission {
  /** Unique emission ID */
  id: string
  /** Current status */
  status: 'pending' | 'complete'
  /** The React component to render */
  component: React.ComponentType<any>
  /** Props to pass to the component (excluding RenderableProps) */
  props: Record<string, unknown>
  /** Response value once user completes interaction */
  response?: unknown | undefined
  /** Callback to complete the emission - only present when pending */
  onRespond?: ((value: unknown) => void) | undefined
}

/**
 * A tool call made by the assistant.
 * 
 * When the LLM decides to use a tool, it creates a tool call. The tool executes
 * and may emit interactive UI components (emissions) during execution.
 */
export interface ChatToolCall {
  /** Tool call ID */
  id: string
  /** Tool name */
  name: string
  /** Arguments passed to the tool */
  arguments: unknown
  /** Current execution state */
  state: 'pending' | 'running' | 'complete' | 'error'
  /** Tool result (when complete) */
  result?: unknown | undefined
  /** Error message (when error) */
  error?: string | undefined
  /** Interactive emissions from this tool (e.g., ctx.render() components) */
  emissions: ChatEmission[]
}

/**
 * A chat message with resolved content.
 *
 * This is the primary type for rendering chat UI. It includes:
 * - Text content (raw and HTML)
 * - Tool calls made during this assistant turn
 * - Interactive emissions from those tool calls
 * 
 * @example
 * ```tsx
 * function Message({ message }: { message: ChatMessage }) {
 *   return (
 *     <div>
 *       {/* Tool calls with inline emissions *\/}
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
 *       
 *       {/* Text content *\/}
 *       {message.html ? (
 *         <div dangerouslySetInnerHTML={{ __html: message.html }} />
 *       ) : message.content}
 *     </div>
 *   )
 * }
 * ```
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
  /** Tool calls made during this assistant turn (assistant messages only) */
  toolCalls?: ChatToolCall[]
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
  /** Metadata from processor (e.g., code fence info) */
  meta?: ContentMetadata
  /** Timestamp of last update */
  timestamp?: number
}

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
   * import { markdown, shiki } from '@tanstack/framework/react/chat/pipeline'
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

  const { state, send, abort, reset } = session

  // Helper to convert emission state to ChatEmission
  const toEmission = (e: ToolEmissionState): ChatEmission => ({
    id: e.id,
    status: e.status === 'error' ? 'complete' : e.status, // Treat error as complete for UI
    component: e.payload._component!,
    props: e.payload.props,
    response: e.response,
    onRespond: e.respond,
  })

  // Helper to build ChatToolCall from tool call data and emissions
  const buildToolCall = (
    id: string,
    name: string,
    args: unknown,
    toolState: 'pending' | 'running' | 'complete' | 'error',
    result?: unknown,
    error?: string
  ): ChatToolCall => {
    // Find emissions for this tool call
    const tracking = state.toolEmissions[id]
    const emissions: ChatEmission[] = tracking?.emissions
      ?.filter(e => e.payload._component) // Only include if component is present
      .map(toEmission) ?? []

    return {
      id,
      name,
      arguments: args,
      state: toolState,
      result,
      error,
      emissions,
    }
  }

  // Transform completed messages to ChatMessage format
  const completedMessages: ChatMessage[] = useMemo(() => {
    return state.messages
      .filter(msg => msg.role !== 'tool') // Filter out tool result messages
      .map((msg): ChatMessage => {
        const rendered = msg.id ? state.rendered[msg.id] : null
        
        // Build tool calls with emissions for assistant messages
        let toolCalls: ChatToolCall[] | undefined
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
          toolCalls = msg.tool_calls.map(tc => {
            // Look for result in tool messages that follow
            const toolResultMsg = state.messages.find(
              m => m.role === 'tool' && m.tool_call_id === tc.id
            )
            const hasError = toolResultMsg?.content?.startsWith('Error:')
            
            return buildToolCall(
              tc.id,
              tc.function.name,
              tc.function.arguments,
              toolResultMsg ? (hasError ? 'error' : 'complete') : 'running',
              toolResultMsg && !hasError ? toolResultMsg.content : undefined,
              hasError ? toolResultMsg?.content : undefined
            )
          })
        }

        return {
          id: msg.id ?? `msg-${Date.now()}`,
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content,
          ...(rendered?.output && { html: rendered.output }),
          isStreaming: false,
          ...(toolCalls && { toolCalls }),
        }
      })
  }, [state.messages, state.rendered, state.toolEmissions])

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

    // Build tool calls from currentResponse during streaming
    const streamingToolCalls: ChatToolCall[] = state.currentResponse
      .filter((step): step is Extract<typeof step, { type: 'tool_call' }> => step.type === 'tool_call')
      .map(step => buildToolCall(
        step.id,
        step.name,
        step.arguments,
        step.state === 'pending' ? 'running' : step.state,
        step.result,
        step.error
      ))

    const streamingChatMessage: ChatMessage = {
      id: 'streaming',
      role: 'assistant',
      content: streamingMessage.content,
      ...(streamingMessage.html && { html: streamingMessage.html }),
      isStreaming: true,
      ...(streamingToolCalls.length > 0 && { toolCalls: streamingToolCalls }),
    }

    return [...completedMessages, streamingChatMessage]
  }, [completedMessages, streamingMessage, state.currentResponse, state.toolEmissions])

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
