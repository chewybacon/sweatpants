/**
 * lib/chat/state/derive-messages.ts
 *
 * Pure functions to derive ChatMessage[] from ChatState.
 * No framework dependencies - just data transformation.
 *
 * These functions enable framework-agnostic message derivation that can be
 * used by React, Vue, Svelte, or any other UI framework.
 *
 * @example React
 * ```tsx
 * const messages = useMemo(() =>
 *   deriveMessages<React.ComponentType<any>>(
 *     state,
 *     (emission) => emission.payload._component
 *   ),
 *   [state]
 * )
 * ```
 *
 * @example Vue
 * ```ts
 * const messages = computed(() =>
 *   deriveMessages<Component>(
 *     state.value,
 *     (emission) => emission.payload._component
 *   )
 * )
 * ```
 */

import type { ChatState, ToolEmissionState, ToolEmissionTrackingState, ResponseStep } from './chat-state'
import type { ChatMessage, ChatToolCall, ChatEmission, StreamingMessage } from '../types/chat-message'

// =============================================================================
// COMPONENT EXTRACTOR TYPE
// =============================================================================

/**
 * Function to extract the component from an emission.
 *
 * This abstraction allows each framework to define how to get the component
 * reference from the emission payload (which stores it as `_component`).
 */
export type ComponentExtractor<TComponent> = (
  emission: ToolEmissionState
) => TComponent | undefined

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Convert a ToolEmissionState to a ChatEmission.
 */
function toEmission<TComponent>(
  emission: ToolEmissionState,
  extractComponent: ComponentExtractor<TComponent>
): ChatEmission<TComponent> | null {
  const component = extractComponent(emission)
  if (!component) return null

  const result: ChatEmission<TComponent> = {
    id: emission.id,
    status: emission.status === 'error' ? 'complete' : emission.status,
    component,
    props: emission.payload.props,
  }

  if (emission.response !== undefined) {
    result.response = emission.response
  }
  if (emission.respond !== undefined) {
    result.onRespond = emission.respond
  }

  return result
}

/**
 * Build a ChatToolCall from tool call data and emissions.
 */
function buildToolCall<TComponent>(
  id: string,
  name: string,
  args: unknown,
  toolState: 'pending' | 'running' | 'complete' | 'error',
  toolEmissions: Record<string, ToolEmissionTrackingState>,
  extractComponent: ComponentExtractor<TComponent>,
  result?: unknown,
  error?: string
): ChatToolCall<TComponent> {
  // Find emissions for this tool call
  const tracking = toolEmissions[id]
  const emissions: ChatEmission<TComponent>[] = []

  if (tracking?.emissions) {
    for (const e of tracking.emissions) {
      const emission = toEmission(e, extractComponent)
      if (emission) {
        emissions.push(emission)
      }
    }
  }

  const toolCall: ChatToolCall<TComponent> = {
    id,
    name,
    arguments: args,
    state: toolState,
    emissions,
  }

  if (result !== undefined) {
    toolCall.result = result
  }
  if (error !== undefined) {
    toolCall.error = error
  }

  return toolCall
}

// =============================================================================
// MAIN DERIVATION FUNCTIONS
// =============================================================================

/**
 * Derive completed messages from ChatState.
 *
 * Transforms the internal message representation into the UI-friendly
 * ChatMessage format, including tool calls and their emissions.
 *
 * @param state - The current ChatState
 * @param extractComponent - Function to extract the component from an emission
 * @returns Array of ChatMessage objects for completed messages
 */
export function deriveCompletedMessages<TComponent>(
  state: ChatState,
  extractComponent: ComponentExtractor<TComponent>
): ChatMessage<TComponent>[] {
  return state.messages
    .filter((msg) => msg.role !== 'tool') // Filter out tool result messages
    .map((msg): ChatMessage<TComponent> => {
      const rendered = msg.id ? state.rendered[msg.id] : null

      // Build tool calls with emissions for assistant messages
      let toolCalls: ChatToolCall<TComponent>[] | undefined
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        toolCalls = msg.tool_calls.map((tc) => {
          // Look for result in tool messages that follow
          const toolResultMsg = state.messages.find(
            (m) => m.role === 'tool' && m.tool_call_id === tc.id
          )
          const hasError = toolResultMsg?.content?.startsWith('Error:')

          return buildToolCall<TComponent>(
            tc.id,
            tc.function.name,
            tc.function.arguments,
            toolResultMsg ? (hasError ? 'error' : 'complete') : 'running',
            state.toolEmissions,
            extractComponent,
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
}

/**
 * Derive the streaming message from ChatState.
 *
 * Returns null if not currently streaming, otherwise returns the
 * StreamingMessage with animation-ready data.
 *
 * @param state - The current ChatState
 * @returns StreamingMessage or null
 */
export function deriveStreamingMessage<TComponent>(
  state: ChatState,
  extractComponent: ComponentExtractor<TComponent>
): StreamingMessage<TComponent> | null {
  if (!state.isStreaming) return null

  const renderable = state.buffer.renderable
  
  // Build tool calls from currentResponse during streaming
  const streamingToolCalls: ChatToolCall<TComponent>[] = state.currentResponse
    .filter((step): step is Extract<ResponseStep, { type: 'tool_call' }> => step.type === 'tool_call')
    .map((step) =>
      buildToolCall<TComponent>(
        step.id,
        step.name,
        step.arguments,
        step.state === 'pending' ? 'running' : step.state,
        state.toolEmissions,
        extractComponent,
        step.result,
        step.error
      )
    )

  if (!renderable) {
    // Fallback to settled content if no renderable buffer
    return {
      role: 'assistant' as const,
      content: state.buffer.settled,
      ...(state.buffer.settledHtml && { html: state.buffer.settledHtml }),
      ...(streamingToolCalls.length > 0 && { toolCalls: streamingToolCalls }),
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
    ...(streamingToolCalls.length > 0 && { toolCalls: streamingToolCalls }),
  }
}

/**
 * Derive all messages (completed + streaming) from ChatState.
 *
 * This is the main function for rendering a chat UI. It combines completed
 * messages with the current streaming message (if any).
 *
 * @param state - The current ChatState
 * @param extractComponent - Function to extract the component from an emission
 * @returns Array of ChatMessage objects including streaming message
 */
export function deriveMessages<TComponent>(
  state: ChatState,
  extractComponent: ComponentExtractor<TComponent>
): ChatMessage<TComponent>[] {
  const completedMessages = deriveCompletedMessages(state, extractComponent)
  const streamingMessage = deriveStreamingMessage(state, extractComponent)

  if (!streamingMessage) {
    return completedMessages
  }

  // Convert StreamingMessage to ChatMessage for the combined array
  const streamingChatMessage: ChatMessage<TComponent> = {
    id: 'streaming',
    role: 'assistant',
    content: streamingMessage.content,
    ...(streamingMessage.html && { html: streamingMessage.html }),
    isStreaming: true,
    ...(streamingMessage.toolCalls && streamingMessage.toolCalls.length > 0 && {
      toolCalls: streamingMessage.toolCalls,
    }),
  }

  return [...completedMessages, streamingChatMessage]
}
