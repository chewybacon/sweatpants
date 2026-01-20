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
 *   deriveMessages<React.ComponentType<any>>(state, { toolEmissions, pendingElicits }),
 *   [state, toolEmissions, pendingElicits]
 * )
 * ```
 */

import type { ChatState, ToolEmissionState, ToolEmissionTrackingState, ElicitTrackingState } from './chat-state.ts'
import type {
  ChatMessage,
  MessagePart,
  TextPart,
  ToolCallPart,
  ChatEmission,
  StreamingMessage,
  PluginElicit,
} from '../types/chat-message.ts'

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
// DERIVE OPTIONS
// =============================================================================

/**
 * Options for deriving messages.
 *
 * These provide the emissions and elicitations that are managed outside
 * ChatState (e.g., React-local state for emissions).
 */
export interface DeriveMessagesOptions {
  /** Tool emissions keyed by call ID */
  toolEmissions?: Record<string, ToolEmissionTrackingState>
  /** Pending elicitations keyed by call ID */
  pendingElicits?: Record<string, ElicitTrackingState>
}

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
 * Build plugin elicits for a tool call part from the pendingElicits state.
 */
function buildPluginElicitsForToolCall(
  callId: string,
  pendingElicits: Record<string, ElicitTrackingState>
): PluginElicit[] {
  const tracking = pendingElicits[callId]
  if (!tracking?.elicitations) return []

  return tracking.elicitations.map((e) => ({
    id: e.elicitId,
    key: e.key,
    message: e.message,
    context: e.context,
    status: e.status as 'pending' | 'responded',
    response: e.response,
    sessionId: e.sessionId,
    callId: e.callId,
    toolName: e.toolName,
  }))
}

/**
 * Enrich a tool call part with emissions and plugin elicits from state.
 */
function enrichToolCallPart<TComponent>(
  part: ToolCallPart<TComponent>,
  toolEmissions: Record<string, ToolEmissionTrackingState>,
  pendingElicits: Record<string, ElicitTrackingState>,
  extractComponent: ComponentExtractor<TComponent>
): ToolCallPart<TComponent> {
  const emissions = buildEmissionsForToolCall(
    part.callId,
    toolEmissions,
    extractComponent
  )
  const pluginElicits = buildPluginElicitsForToolCall(
    part.callId,
    pendingElicits
  )

  const hasNewEmissions = emissions.length > 0
  const hasNewPluginElicits = pluginElicits.length > 0
  const hasExistingEmissions = part.emissions.length > 0
  const hasExistingPluginElicits = (part.pluginElicits ?? []).length > 0

  if (!hasNewEmissions && !hasNewPluginElicits && !hasExistingEmissions && !hasExistingPluginElicits) {
    return part
  }

  return {
    ...part,
    emissions: hasNewEmissions ? emissions : part.emissions,
    pluginElicits: hasNewPluginElicits ? pluginElicits : (part.pluginElicits ?? []),
  }
}

/**
 * Enrich all parts with emissions and plugin elicits.
 */
function enrichParts<TComponent>(
  parts: MessagePart<TComponent>[],
  toolEmissions: Record<string, ToolEmissionTrackingState>,
  pendingElicits: Record<string, ElicitTrackingState>,
  extractComponent: ComponentExtractor<TComponent>
): MessagePart<TComponent>[] {
  return parts.map((part) => {
    if (part.type === 'tool-call') {
      return enrichToolCallPart(part, toolEmissions, pendingElicits, extractComponent)
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
 * Uses finalizedParts when available (for messages with rendered frames),
 * falling back to constructing parts from message content.
 *
 * @param state - The current ChatState
 * @param options - Options containing toolEmissions and pendingElicits
 * @param extractComponent - Function to extract the component from an emission
 * @returns Array of ChatMessage objects for completed messages
 */
export function deriveCompletedMessages<TComponent>(
  state: ChatState,
  options: DeriveMessagesOptions,
  extractComponent: ComponentExtractor<TComponent>
): ChatMessage<TComponent>[] {
  const toolEmissions = options.toolEmissions ?? {}
  const pendingElicits = options.pendingElicits ?? {}

  return state.messages
    .filter((msg) => msg.role !== 'tool') // Filter out tool result messages
    .map((msg): ChatMessage<TComponent> => {
      const messageId = msg.id ?? `msg-${Date.now()}`
      
      // Check if we have finalized parts with frames for this message
      const storedParts = state.finalizedParts[messageId]
      
      
      if (storedParts && storedParts.length > 0) {
        // Use the stored parts (they have frames from the pipeline)
        const enrichedParts = enrichParts(
          storedParts as MessagePart<TComponent>[],
          toolEmissions,
          pendingElicits,
          extractComponent
        )
        
        return {
          id: messageId,
          role: msg.role as 'user' | 'assistant' | 'system',
          parts: enrichedParts,
          isStreaming: false,
        }
      }
      
      // Fallback: construct parts from message content (no frames)
      const parts: MessagePart<TComponent>[] = []

      if (msg.content) {
        parts.push({
          id: `${messageId}-text`,
          type: 'text',
          content: msg.content,
          rendered: msg.content, // No frame available, use raw content
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
            id: `${messageId}-tool-${tc.id}`,
            type: 'tool-call',
            callId: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
            state: toolResultMsg ? (hasError ? 'error' : 'complete') : 'running',
            emissions: [],
            pluginElicits: [],
          }

          if (toolResultMsg && !hasError && toolResultMsg.content) {
            toolPart.result = toolResultMsg.content
          }
          if (hasError && toolResultMsg?.content) {
            toolPart.error = toolResultMsg.content
          }

          // Enrich with emissions and plugin elicits
          const enrichedPart = enrichToolCallPart(
            toolPart,
            toolEmissions,
            pendingElicits,
            extractComponent
          )
          parts.push(enrichedPart)
        }
      }

      return {
        id: messageId,
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
 * @param options - Options containing toolEmissions and pendingElicits
 * @param extractComponent - Function to extract the component from an emission
 * @returns StreamingMessage or null
 */
export function deriveStreamingMessage<TComponent>(
  state: ChatState,
  options: DeriveMessagesOptions,
  extractComponent: ComponentExtractor<TComponent>
): StreamingMessage<TComponent> | null {
  if (!state.isStreaming) return null

  const toolEmissions = options.toolEmissions ?? {}
  const pendingElicits = options.pendingElicits ?? {}

  // Enrich parts with emissions and plugin elicits
  const parts = enrichParts(
    state.streaming.parts as MessagePart<TComponent>[],
    toolEmissions,
    pendingElicits,
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
 * @param options - Options containing toolEmissions and pendingElicits
 * @param extractComponent - Function to extract the component from an emission
 * @returns Array of ChatMessage objects including streaming message
 */
export function deriveMessages<TComponent>(
  state: ChatState,
  options: DeriveMessagesOptions,
  extractComponent: ComponentExtractor<TComponent>
): ChatMessage<TComponent>[] {
  const completedMessages = deriveCompletedMessages(state, options, extractComponent)
  const streamingMessage = deriveStreamingMessage(state, options, extractComponent)

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
