/**
 * lib/chat/state/derive-messages.ts
 *
 * Pure functions to derive ChatMessage[] from ChatState.
 * No framework dependencies - just data transformation.
 *
 * ## Parts-Based Model
 *
 * Messages are composed of ordered parts (text, reasoning, tool-call).
 * Each part can have its own Frame from the pipeline.
 *
 * @example React
 * ```tsx
 * const messages = useMemo(() =>
 *   deriveMessages<React.ComponentType<any>>(state),
 *   [state]
 * )
 * ```
 */

import type { ChatState, ToolEmissionState, ToolEmissionTrackingState } from './chat-state'
import type {
  ChatMessage,
  MessagePart,
  TextPart,
  ToolCallPart,
  ChatEmission,
  StreamingMessage,
} from '../types/chat-message'

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
 * Build emissions for a tool call part from the toolEmissions state.
 */
function buildEmissionsForToolCall<TComponent>(
  callId: string,
  toolEmissions: Record<string, ToolEmissionTrackingState>,
  extractComponent: ComponentExtractor<TComponent>
): ChatEmission<TComponent>[] {
  const tracking = toolEmissions[callId]
  if (!tracking?.emissions) return []

  const emissions: ChatEmission<TComponent>[] = []
  for (const e of tracking.emissions) {
    const emission = toEmission(e, extractComponent)
    if (emission) {
      emissions.push(emission)
    }
  }
  return emissions
}

/**
 * Enrich a tool call part with emissions from the toolEmissions state.
 */
function enrichToolCallPart<TComponent>(
  part: ToolCallPart<TComponent>,
  toolEmissions: Record<string, ToolEmissionTrackingState>,
  extractComponent: ComponentExtractor<TComponent>
): ToolCallPart<TComponent> {
  const emissions = buildEmissionsForToolCall(
    part.callId,
    toolEmissions,
    extractComponent
  )

  if (emissions.length === 0 && part.emissions.length === 0) {
    return part
  }

  return {
    ...part,
    emissions: emissions.length > 0 ? emissions : part.emissions,
  }
}

/**
 * Enrich all parts with emissions.
 */
function enrichParts<TComponent>(
  parts: MessagePart<TComponent>[],
  toolEmissions: Record<string, ToolEmissionTrackingState>,
  extractComponent: ComponentExtractor<TComponent>
): MessagePart<TComponent>[] {
  return parts.map((part) => {
    if (part.type === 'tool-call') {
      return enrichToolCallPart(part, toolEmissions, extractComponent)
    }
    return part
  })
}

// =============================================================================
// MAIN DERIVATION FUNCTIONS
// =============================================================================

/**
 * Derive completed messages from ChatState.
 *
 * Transforms the internal message representation into the UI-friendly
 * ChatMessage format.
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
      // Convert internal message to ChatMessage with parts
      // For now, messages from history just have a single text part
      const parts: MessagePart<TComponent>[] = []

      if (msg.content) {
        parts.push({
          id: `${msg.id}-text`,
          type: 'text',
          content: msg.content,
        } as TextPart)
      }

      // Add tool calls from the message if present
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          // Look for result in tool messages that follow
          const toolResultMsg = state.messages.find(
            (m) => m.role === 'tool' && m.tool_call_id === tc.id
          )
          const hasError = toolResultMsg?.content?.startsWith('Error:')

          const toolPart: ToolCallPart<TComponent> = {
            id: `${msg.id}-tool-${tc.id}`,
            type: 'tool-call',
            callId: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
            state: toolResultMsg ? (hasError ? 'error' : 'complete') : 'running',
            emissions: [],
          }

          if (toolResultMsg && !hasError && toolResultMsg.content) {
            toolPart.result = toolResultMsg.content
          }
          if (hasError && toolResultMsg?.content) {
            toolPart.error = toolResultMsg.content
          }

          // Enrich with emissions
          const enrichedPart = enrichToolCallPart(
            toolPart,
            state.toolEmissions,
            extractComponent
          )
          parts.push(enrichedPart)
        }
      }

      return {
        id: msg.id ?? `msg-${Date.now()}`,
        role: msg.role as 'user' | 'assistant' | 'system',
        parts,
        isStreaming: false,
      }
    })
}

/**
 * Derive the streaming message from ChatState.
 *
 * Returns null if not currently streaming, otherwise returns the
 * StreamingMessage with the current parts.
 *
 * @param state - The current ChatState
 * @param extractComponent - Function to extract the component from an emission
 * @returns StreamingMessage or null
 */
export function deriveStreamingMessage<TComponent>(
  state: ChatState,
  extractComponent: ComponentExtractor<TComponent>
): StreamingMessage<TComponent> | null {
  if (!state.isStreaming) return null

  // Enrich parts with emissions
  const parts = enrichParts(
    state.streaming.parts as MessagePart<TComponent>[],
    state.toolEmissions,
    extractComponent
  )

  return {
    role: 'assistant',
    parts,
    activePartId: state.streaming.activePartId,
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
    parts: streamingMessage.parts,
    isStreaming: true,
  }

  return [...completedMessages, streamingChatMessage]
}
