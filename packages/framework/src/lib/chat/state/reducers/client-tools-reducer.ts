/**
 * lib/chat/state/reducers/client-tools-reducer.ts
 */
import type { ChatState } from '../chat-state.ts'
import type { ChatPatch } from '../../patches/index.ts'

export function reduceClientTools(state: ChatState, patch: ChatPatch): ChatState | undefined {
  switch (patch.type) {
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

    case 'client_tool_error':
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

    case 'client_tool_denied':
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

    case 'client_tool_progress':
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

    case 'client_tool_permission_request':
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

    default:
      return undefined
  }
}
