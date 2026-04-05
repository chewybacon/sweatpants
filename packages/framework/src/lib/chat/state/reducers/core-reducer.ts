/**
 * lib/chat/state/reducers/core-reducer.ts
 */
import type { ChatState } from '../chat-state.ts'
import { initialChatState } from '../chat-state.ts'
import type { ChatPatch } from '../../patches/index.ts'

export function reduceCore(state: ChatState, patch: ChatPatch): ChatState | undefined {
  switch (patch.type) {
    case 'session_info':
      return {
        ...state,
        capabilities: patch.capabilities,
        persona: patch.persona,
      }

    case 'user_message':
    case 'history_message':
      return {
        ...state,
        messages:
          patch.message.id && state.messages.some((message) => message.id === patch.message.id)
            ? state.messages.map((message) => (message.id === patch.message.id ? patch.message : message))
            : [...state.messages, patch.message],
        ...(
          patch.type === 'history_message' &&
          patch.message.id &&
          patch.parts &&
          patch.parts.length > 0
            ? {
                finalizedParts: {
                  ...state.finalizedParts,
                  [patch.message.id]: patch.parts,
                },
              }
            : {}
        ),
        error: null,
      }

    case 'error':
      return {
        ...state,
        error: patch.message,
        isStreaming: false,
      }

    case 'reset':
      return initialChatState

    default:
      return undefined
  }
}
