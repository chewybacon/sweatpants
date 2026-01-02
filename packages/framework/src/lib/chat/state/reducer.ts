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
import type { ChatState, ToolEmissionState, ToolEmissionTrackingState, StreamingPartsState } from './chat-state'
import { initialChatState } from './chat-state'
import type { ChatPatch, ContentPartType } from '../patches'
import type { MessagePart, TextPart, ReasoningPart, ToolCallPart } from '../types/chat-message'
import { generatePartId } from '../types/chat-message'
// Frame type is used via the patch types

// Re-export types for convenience
export type { ChatState, ToolEmissionState, ToolEmissionTrackingState }
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
      return {
        ...state,
        streaming: {
          ...streaming,
          parts: updatePart(streaming.parts, streaming.activePartId, (p) => ({
            ...p,
            content: (p as TextPart | ReasoningPart).content + content,
          })),
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
 * Finalize the streaming message and convert to a completed message.
 */
function finalizeStreamingMessage(state: ChatState): ChatState {
  // The streaming parts become part of a message
  // For now, we'll let the derive-messages function handle the conversion
  return {
    ...state,
    isStreaming: false,
    streaming: initialChatState.streaming,
  }
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

    // Legacy: treat streaming_thinking as streaming_reasoning
    case 'streaming_thinking':
      return handleContentStreaming(state, patch.content, 'reasoning')

    case 'streaming_text':
      return handleContentStreaming(state, patch.content, 'text')

    case 'part_frame': {
      // Update the frame for a specific part
      const part = findPart(state.streaming.parts, patch.partId)
      if (!part) return state

      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: updatePart(state.streaming.parts, patch.partId, (p) => ({
            ...p,
            frame: patch.frame,
          })),
        },
      }
    }

    case 'part_end': {
      // Finalize a part with its final frame
      const part = findPart(state.streaming.parts, patch.partId)
      if (!part) return state

      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: updatePart(state.streaming.parts, patch.partId, (p) => ({
            ...p,
            frame: patch.frame,
          })),
          // Clear active part if this was it
          activePartId: state.streaming.activePartId === patch.partId 
            ? null 
            : state.streaming.activePartId,
          activePartType: state.streaming.activePartId === patch.partId 
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
      // Streaming complete - add message
      // The streaming parts should already be finalized
      return {
        ...state,
        messages: [...state.messages, patch.message],
        streaming: initialChatState.streaming,
      }
    }

    case 'streaming_end':
      return finalizeStreamingMessage(state)

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

    default:
      return state
  }
}
