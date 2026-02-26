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
      return {
        ...state,
        messages: [...state.messages, patch.message],
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
