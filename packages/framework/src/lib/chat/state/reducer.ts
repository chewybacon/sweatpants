/**
 * lib/chat/state/reducer.ts
 *
 * Pure reducer for chat state. Framework-agnostic - can be used with
 * React, Vue, Svelte, or any state management system.
 *
 * ## Parts-Based Model
 *
 * The reducer handles a parts-based streaming model:
 * - streaming_text → TextPart
 * - streaming_reasoning → ReasoningPart
 * - tool_call_start → ToolCallPart
 * - part_frame → Updates a part's Frame
 *
 * When content type switches, the current part is finalized and a new one starts.
 */
import type { ChatState, ToolEmissionState, ToolEmissionTrackingState, PluginElicitState, PluginElicitTrackingState, StreamingPartsState } from './chat-state'
import { initialChatState } from './chat-state'
import type { ChatPatch, ContentPartType } from '../patches'
import type { MessagePart, TextPart, ReasoningPart, ToolCallPart } from '../types/chat-message'
import { generatePartId, getRenderedFromFrame } from '../types/chat-message'
import type { Message } from '../types'

// Re-export types for convenience
export type { ChatState, ToolEmissionState, ToolEmissionTrackingState, PluginElicitState, PluginElicitTrackingState }
export { initialChatState }

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create a new text part.
 */
function createTextPart(content: string): TextPart {
  return {
    id: generatePartId(),
    type: 'text',
    content,
    rendered: content, // Will be updated with frame HTML when available
  }
}

/**
 * Create a new reasoning part.
 */
function createReasoningPart(content: string): ReasoningPart {
  return {
    id: generatePartId(),
    type: 'reasoning',
    content,
    rendered: content, // Will be updated with frame HTML when available
  }
}

/**
 * Create a new tool call part.
 */
function createToolCallPart(callId: string, name: string, args: string): ToolCallPart {
  return {
    id: generatePartId(),
    type: 'tool-call',
    callId,
    name,
    arguments: args,
    state: 'pending',
    emissions: [],
  }
}

/**
 * Find a part by ID in the streaming parts.
 */
function findPart(parts: MessagePart[], partId: string): MessagePart | undefined {
  return parts.find(p => p.id === partId)
}

/**
 * Update a part by ID.
 */
function updatePart(
  parts: MessagePart[],
  partId: string,
  updater: (part: MessagePart) => MessagePart
): MessagePart[] {
  return parts.map(p => (p.id === partId ? updater(p) : p))
}

/**
 * Get the active content part (text or reasoning).
 */
function getActiveContentPart(
  streaming: StreamingPartsState
): TextPart | ReasoningPart | null {
  if (!streaming.activePartId) return null
  const part = findPart(streaming.parts, streaming.activePartId)
  if (part?.type === 'text' || part?.type === 'reasoning') {
    return part
  }
  return null
}

/**
 * Handle content streaming (text or reasoning).
 * Manages part switching when content type changes.
 */
function handleContentStreaming(
  state: ChatState,
  content: string,
  partType: ContentPartType
): ChatState {
  const { streaming } = state

  // If we're already streaming the same type, append
  if (streaming.activePartType === partType && streaming.activePartId) {
    const activePart = getActiveContentPart(streaming)
    if (activePart) {
      const newContent = activePart.content + content
      return {
        ...state,
        streaming: {
          ...streaming,
          parts: updatePart(streaming.parts, streaming.activePartId, (p) => {
            const contentPart = p as TextPart | ReasoningPart
            return {
              ...p,
              content: newContent,
              // Update rendered with raw content if no frame yet
              // Once a frame is applied, rendered will be the HTML
              rendered: contentPart.frame ? contentPart.rendered : newContent,
            }
          }),
        },
      }
    }
  }

  // Content type changed or first content - create new part
  const newPart = partType === 'text'
    ? createTextPart(content)
    : createReasoningPart(content)

  return {
    ...state,
    streaming: {
      ...streaming,
      parts: [...streaming.parts, newPart],
      activePartId: newPart.id,
      activePartType: partType,
    },
  }
}

/**
 * Find the last message with a given role.
 */
function findLastMessageByRole(messages: Message[], role: string): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === role) {
      return messages[i]
    }
  }
  return undefined
}

// =============================================================================
// REDUCER
// =============================================================================

/**
 * Apply a patch to the chat state (pure reducer).
 *
 * Uses a parts-based model:
 * - streaming.parts accumulates parts as content streams in
 * - streaming.activePartId tracks the currently active part
 * - Part type switches create new parts
 */
export function chatReducer(state: ChatState, patch: ChatPatch): ChatState {
  switch (patch.type) {
    case 'session_info':
      return {
        ...state,
        capabilities: patch.capabilities,
        persona: patch.persona,
      }

    case 'user_message':
      return {
        ...state,
        messages: [...state.messages, patch.message],
        error: null,
      }

    case 'streaming_start':
      return {
        ...state,
        isStreaming: true,
        streaming: {
          parts: [],
          activePartId: null,
          activePartType: null,
        },
        error: null,
      }

    case 'streaming_reasoning':
      return handleContentStreaming(state, patch.content, 'reasoning')

    case 'streaming_text':
      return handleContentStreaming(state, patch.content, 'text')

    case 'part_frame': {
      // Update the frame for the active part of the given type.
      // The partId from the pipeline transform may not match the reducer's part ID,
      // so we match by part type instead (there's only one active part of each type).
      const activePartId = state.streaming.activePartId
      const activePartType = state.streaming.activePartType
      
      // Compute rendered HTML from the frame
      const rendered = getRenderedFromFrame(patch.frame)
      
      // Match by part type - the pipeline transform tells us which type this frame is for
      if (!activePartId || activePartType !== patch.partType) {
        // No matching active part - maybe it's for a previous part, try by ID
        const part = findPart(state.streaming.parts, patch.partId)
        if (!part) return state
        
        return {
          ...state,
          streaming: {
            ...state.streaming,
            parts: updatePart(state.streaming.parts, patch.partId, (p) => ({
              ...p,
              frame: patch.frame,
              ...(rendered !== null && { rendered }),
            })),
          },
        }
      }

      // Update the active part with the frame
      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: updatePart(state.streaming.parts, activePartId, (p) => ({
            ...p,
            frame: patch.frame,
            ...(rendered !== null && { rendered }),
          })),
        },
      }
    }

    case 'part_end': {
      // Finalize a part with its final frame.
      // Match by part type first (like part_frame), fall back to ID.
      const activePartId = state.streaming.activePartId
      const activePartType = state.streaming.activePartType
      
      // Compute rendered HTML from the frame
      const rendered = getRenderedFromFrame(patch.frame)
      
      // Determine which part to update
      let targetPartId: string | null = null
      
      if (activePartId && activePartType === patch.partType) {
        // Active part matches the type being finalized
        targetPartId = activePartId
      } else {
        // Try by ID (for cases where part type already changed)
        const part = findPart(state.streaming.parts, patch.partId)
        if (part) {
          targetPartId = patch.partId
        }
      }
      
      if (!targetPartId) return state

      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: updatePart(state.streaming.parts, targetPartId, (p) => ({
            ...p,
            frame: patch.frame,
            ...(rendered !== null && { rendered }),
          })),
          // Clear active part if this was it
          activePartId: state.streaming.activePartId === targetPartId 
            ? null 
            : state.streaming.activePartId,
          activePartType: state.streaming.activePartId === targetPartId 
            ? null 
            : state.streaming.activePartType,
        },
      }
    }

    case 'tool_call_start': {
      // Tool calls interrupt content streaming
      // Create a new tool-call part
      const toolPart = createToolCallPart(
        patch.call.id,
        patch.call.name,
        patch.call.arguments
      )

      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: [...state.streaming.parts, toolPart],
          // Tool call becomes the "active" part (not content though)
          activePartId: null,
          activePartType: 'tool-call',
        },
      }
    }

    case 'tool_call_result': {
      // Update matching tool call part
      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: state.streaming.parts.map((part) =>
            part.type === 'tool-call' && part.callId === patch.id
              ? { ...part, state: 'complete' as const, result: patch.result }
              : part
          ),
        },
      }
    }

    case 'tool_call_error': {
      // Update matching tool call part
      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: state.streaming.parts.map((part) =>
            part.type === 'tool-call' && part.callId === patch.id
              ? { ...part, state: 'error' as const, error: patch.error }
              : part
          ),
        },
      }
    }

    case 'assistant_message': {
      // Add the message to history. Don't finalize parts here - that happens in streaming_end
      // which comes AFTER part_end has attached the final frames.
      const messageId = patch.message.id ?? `msg-${Date.now()}`

      // Ensure the message has an ID
      const messageWithId = patch.message.id 
        ? patch.message 
        : { ...patch.message, id: messageId }
      
      
      return {
        ...state,
        messages: [...state.messages, messageWithId],
        // Don't reset streaming yet - wait for streaming_end
      }
    }

    case 'streaming_end': {
      // Streaming complete - save the finalized parts (with frames) and reset streaming state
      // At this point, part_end has already been processed so parts have their final frames.

      // Find the last assistant message to get its ID
      const lastMessage = findLastMessageByRole(state.messages, 'assistant')
      const messageId = lastMessage?.id

      // Save finalized parts if we have a message ID and parts
      const newFinalizedParts = messageId && state.streaming.parts.length > 0
        ? {
            ...state.finalizedParts,
            [messageId]: [...state.streaming.parts],
          }
        : state.finalizedParts

      return {
        ...state,
        isStreaming: false,
        finalizedParts: newFinalizedParts,
        streaming: initialChatState.streaming,
      }
    }

    case 'abort_complete': {
      // User aborted - preserve partial content if message provided
      if (patch.message) {
        return {
          ...state,
          messages: [...state.messages, patch.message],
          streaming: initialChatState.streaming,
          isStreaming: false,
        }
      }

      // No message to preserve - just end streaming
      return {
        ...state,
        isStreaming: false,
        streaming: initialChatState.streaming,
      }
    }

    case 'error':
      return {
        ...state,
        error: patch.message,
        isStreaming: false,
      }

    case 'reset':
      return initialChatState

    // --- Buffer patches (legacy - may be removed) ---
    case 'buffer_settled':
    case 'buffer_pending':
    case 'buffer_raw':
    case 'buffer_renderable':
      // These are handled by the parts/frames now
      // Just pass through for backwards compatibility
      return state

    // --- Client Tool Patches ---

    case 'client_tool_awaiting_approval':
      return {
        ...state,
        pendingClientTools: {
          ...state.pendingClientTools,
          [patch.id]: {
            id: patch.id,
            name: patch.name,
            state: 'awaiting_approval',
            approvalMessage: patch.message,
          },
        },
      }

    case 'client_tool_executing':
      return {
        ...state,
        pendingClientTools: {
          ...state.pendingClientTools,
          [patch.id]: {
            ...state.pendingClientTools[patch.id],
            state: 'executing',
          },
        } as ChatState['pendingClientTools'],
      }

    case 'client_tool_complete': {
      const completed = state.pendingClientTools[patch.id]
      return {
        ...state,
        pendingClientTools: {
          ...state.pendingClientTools,
          [patch.id]: {
            ...completed,
            state: 'complete',
            result: patch.result,
          },
        } as ChatState['pendingClientTools'],
      }
    }

    case 'client_tool_error': {
      return {
        ...state,
        pendingClientTools: {
          ...state.pendingClientTools,
          [patch.id]: {
            ...state.pendingClientTools[patch.id],
            state: 'error',
            error: patch.error,
          },
        } as ChatState['pendingClientTools'],
      }
    }

    case 'client_tool_denied': {
      return {
        ...state,
        pendingClientTools: {
          ...state.pendingClientTools,
          [patch.id]: {
            ...state.pendingClientTools[patch.id],
            state: 'denied',
            denialReason: patch.reason,
          },
        } as ChatState['pendingClientTools'],
      }
    }

    case 'client_tool_progress': {
      return {
        ...state,
        pendingClientTools: {
          ...state.pendingClientTools,
          [patch.id]: {
            ...state.pendingClientTools[patch.id],
            progressMessage: patch.message,
          },
        } as ChatState['pendingClientTools'],
      }
    }

    case 'client_tool_permission_request': {
      return {
        ...state,
        pendingClientTools: {
          ...state.pendingClientTools,
          [patch.id]: {
            ...state.pendingClientTools[patch.id],
            state: 'awaiting_approval',
            permissionType: patch.permissionType,
          },
        } as ChatState['pendingClientTools'],
      }
    }

    // --- Tool Handoff Patches (for React Tool Handlers) ---

    case 'pending_handoff': {
      return {
        ...state,
        pendingHandoffs: {
          ...state.pendingHandoffs,
          [patch.handoff.callId]: patch.handoff,
        },
      }
    }

    case 'handoff_complete': {
      const { [patch.callId]: _completed, ...remaining } = state.pendingHandoffs
      return {
        ...state,
        pendingHandoffs: remaining,
      }
    }

    // --- Tool Emission Patches (ctx.render() pattern) ---

    case 'tool_emission_start': {
      return {
        ...state,
        toolEmissions: {
          ...state.toolEmissions,
          [patch.callId]: {
            callId: patch.callId,
            toolName: patch.toolName,
            emissions: [],
            status: 'running',
            startedAt: Date.now(),
          },
        },
      }
    }

    case 'tool_emission': {
      const tracking = state.toolEmissions[patch.callId]

      // Build the emission state
      const newEmission: ToolEmissionState = {
        ...patch.emission,
        callId: patch.callId,
        toolName: tracking?.toolName ?? '',
      }
      if (patch.respond) {
        newEmission.respond = patch.respond
      }

      if (!tracking) {
        // Auto-create tracking if not started explicitly
        return {
          ...state,
          toolEmissions: {
            ...state.toolEmissions,
            [patch.callId]: {
              callId: patch.callId,
              toolName: '',
              emissions: [newEmission],
              status: 'running',
              startedAt: Date.now(),
            },
          },
        }
      }

      // Also update the tool-call part's emissions if it exists
      const updatedParts = state.streaming.parts.map((part) => {
        if (part.type === 'tool-call' && part.callId === patch.callId) {
          return {
            ...part,
            emissions: [...part.emissions, {
              id: patch.emission.id,
              status: patch.emission.status as 'pending' | 'complete',
              component: patch.emission.payload._component,
              props: patch.emission.payload.props,
            }],
          }
        }
        return part
      })

      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: updatedParts,
        },
        toolEmissions: {
          ...state.toolEmissions,
          [patch.callId]: {
            ...tracking,
            emissions: [...tracking.emissions, newEmission],
          },
        },
      }
    }

    case 'tool_emission_response': {
      const tracking = state.toolEmissions[patch.callId]
      if (!tracking) return state

      return {
        ...state,
        toolEmissions: {
          ...state.toolEmissions,
          [patch.callId]: {
            ...tracking,
            emissions: tracking.emissions.map((emission): ToolEmissionState => {
              if (emission.id !== patch.emissionId) {
                return emission
              }
              // Create completed emission without respond callback
              const { respond: _respond, ...rest } = emission
              return {
                ...rest,
                status: 'complete',
                response: patch.response,
              }
            }),
          },
        },
      }
    }

    case 'tool_emission_complete': {
      const { [patch.callId]: _completed, ...remainingEmissions } = state.toolEmissions

      return {
        ...state,
        toolEmissions: remainingEmissions,
      }
    }

    // =========================================================================
    // PLUGIN ELICITATION PATCHES
    // =========================================================================

    case 'plugin_elicit_start': {
      return {
        ...state,
        pluginElicitations: {
          ...state.pluginElicitations,
          [patch.callId]: {
            callId: patch.callId,
            toolName: patch.toolName,
            elicitations: [],
            status: 'awaiting_elicit',
            startedAt: Date.now(),
          },
        },
      }
    }

    case 'plugin_elicit': {
      const tracking = state.pluginElicitations[patch.callId]

      const newElicit = {
        ...patch.elicit,
        callId: patch.callId,
        toolName: tracking?.toolName ?? '',
      }

      if (!tracking) {
        // Auto-create tracking if not started explicitly
        return {
          ...state,
          pluginElicitations: {
            ...state.pluginElicitations,
            [patch.callId]: {
              callId: patch.callId,
              toolName: '',
              elicitations: [newElicit],
              status: 'awaiting_elicit',
              startedAt: Date.now(),
            },
          },
        }
      }

      return {
        ...state,
        pluginElicitations: {
          ...state.pluginElicitations,
          [patch.callId]: {
            ...tracking,
            elicitations: [...tracking.elicitations, newElicit],
          },
        },
      }
    }

    case 'plugin_elicit_response': {
      const tracking = state.pluginElicitations[patch.callId]
      if (!tracking) return state

      return {
        ...state,
        pluginElicitations: {
          ...state.pluginElicitations,
          [patch.callId]: {
            ...tracking,
            elicitations: tracking.elicitations.map((e) =>
              e.elicitId === patch.elicitId
                ? { ...e, status: 'responded' as const, response: patch.response }
                : e
            ),
          },
        },
      }
    }

    case 'plugin_elicit_complete': {
      const { [patch.callId]: _completed, ...remainingElicitations } = state.pluginElicitations

      return {
        ...state,
        pluginElicitations: remainingElicitations,
      }
    }

    default:
      return state
  }
}
