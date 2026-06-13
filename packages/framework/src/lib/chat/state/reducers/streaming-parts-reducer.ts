/**
 * lib/chat/state/reducers/streaming-parts-reducer.ts
 *
 * Reducer for streaming parts, tool call parts, and streaming lifecycle.
 */
import type { ChatState, StreamingPartsState } from '../chat-state.ts'
import { initialChatState } from '../chat-state.ts'
import type { ChatPatch, ContentPartType } from '../../patches/index.ts'
import type { MessagePart, TextPart, ReasoningPart, ToolCallPart } from '../../types/chat-message.ts'
import { generatePartId, getRenderedFromFrame } from '../../types/chat-message.ts'
import type { Message } from '../../types.ts'

/**
 * Create a new text part.
 */
function createTextPart(content: string): TextPart {
  return {
    id: generatePartId(),
    type: 'text',
    content,
    rendered: content,
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
    rendered: content,
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
    pluginElicits: [],
  }
}

/**
 * Find a part by ID in the streaming parts.
 */
function findPart(parts: MessagePart[], partId: string): MessagePart | undefined {
  return parts.find((p) => p.id === partId)
}

/**
 * Update a part by ID.
 */
function updatePart(
  parts: MessagePart[],
  partId: string,
  updater: (part: MessagePart) => MessagePart
): MessagePart[] {
  return parts.map((p) => (p.id === partId ? updater(p) : p))
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
              rendered: contentPart.frame ? contentPart.rendered : newContent,
            }
          }),
        },
      }
    }
  }

  const newPart = partType === 'text' ? createTextPart(content) : createReasoningPart(content)

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

export function reduceStreamingParts(state: ChatState, patch: ChatPatch): ChatState | undefined {
  switch (patch.type) {
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
      const activePartId = state.streaming.activePartId
      const activePartType = state.streaming.activePartType
      const rendered = getRenderedFromFrame(patch.frame)

      if (!activePartId || activePartType !== patch.partType) {
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
      const activePartId = state.streaming.activePartId
      const activePartType = state.streaming.activePartType
      const rendered = getRenderedFromFrame(patch.frame)
      let targetPartId: string | null = null

      if (activePartId && activePartType === patch.partType) {
        targetPartId = activePartId
      } else {
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
          activePartId:
            state.streaming.activePartId === targetPartId ? null : state.streaming.activePartId,
          activePartType:
            state.streaming.activePartId === targetPartId ? null : state.streaming.activePartType,
        },
      }
    }

    case 'tool_call_start': {
      const toolPart = createToolCallPart(patch.call.id, patch.call.name, patch.call.arguments)

      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: [...state.streaming.parts, toolPart],
          activePartId: null,
          activePartType: 'tool-call',
        },
      }
    }

    case 'tool_call_result':
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

    case 'tool_call_error':
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

    case 'assistant_message': {
      const messageId = patch.message.id ?? `msg-${Date.now()}`
      const messageWithId = patch.message.id ? patch.message : { ...patch.message, id: messageId }

      return {
        ...state,
        messages: state.messages.some((message) => message.id === messageId)
          ? state.messages.map((message) => (message.id === messageId ? messageWithId : message))
          : [...state.messages, messageWithId],
      }
    }

    case 'streaming_end': {
      const lastMessage = findLastMessageByRole(state.messages, 'assistant')
      const messageId = lastMessage?.id
      const newFinalizedParts =
        messageId && state.streaming.parts.length > 0
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
      if (patch.message) {
        return {
          ...state,
          messages: [...state.messages, patch.message],
          streaming: initialChatState.streaming,
          isStreaming: false,
        }
      }

      return {
        ...state,
        isStreaming: false,
        streaming: initialChatState.streaming,
      }
    }

    default:
      return undefined
  }
}
