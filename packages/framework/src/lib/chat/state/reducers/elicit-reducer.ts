/**
 * lib/chat/state/reducers/elicit-reducer.ts
 */
import type { ChatState } from '../chat-state.ts'
import type { ChatPatch } from '../../patches/index.ts'

export function reduceElicits(state: ChatState, patch: ChatPatch): ChatState | undefined {
  switch (patch.type) {
    case 'elicit_start':
      return {
        ...state,
        pendingElicits: {
          ...state.pendingElicits,
          [patch.callId]: {
            callId: patch.callId,
            toolName: patch.toolName,
            elicitations: [],
            status: 'awaiting_elicit',
            startedAt: Date.now(),
          },
        },
      }

    case 'elicit': {
      const tracking = state.pendingElicits[patch.callId]
      const toolName = tracking?.toolName ?? ''

      const newElicit = {
        ...patch.elicit,
        callId: patch.callId,
        toolName,
      }

      const elicitForPart = {
        id: patch.elicit.elicitId,
        key: patch.elicit.key,
        message: patch.elicit.message,
        context: patch.elicit.context,
        status: patch.elicit.status as 'pending' | 'responded',
        sessionId: patch.elicit.sessionId,
        callId: patch.callId,
        toolName,
      }

      const updatedParts = state.streaming.parts.map((part) => {
        if (part.type === 'tool-call' && part.callId === patch.callId) {
          return {
            ...part,
            pluginElicits: [...(part.pluginElicits ?? []), elicitForPart],
          }
        }
        return part
      })

      if (!tracking) {
        return {
          ...state,
          streaming: {
            ...state.streaming,
            parts: updatedParts,
          },
          pendingElicits: {
            ...state.pendingElicits,
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
        streaming: {
          ...state.streaming,
          parts: updatedParts,
        },
        pendingElicits: {
          ...state.pendingElicits,
          [patch.callId]: {
            ...tracking,
            elicitations: [...tracking.elicitations, newElicit],
          },
        },
      }
    }

    case 'elicit_response': {
      const tracking = state.pendingElicits[patch.callId]
      if (!tracking) return state

      const updatedParts = state.streaming.parts.map((part) => {
        if (part.type === 'tool-call' && part.callId === patch.callId) {
          return {
            ...part,
            pluginElicits: (part.pluginElicits ?? []).map((e) =>
              e.id === patch.elicitId
                ? { ...e, status: 'responded' as const, response: patch.response }
                : e
            ),
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
        pendingElicits: {
          ...state.pendingElicits,
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

    case 'elicit_complete': {
      const { [patch.callId]: _completed, ...remainingElicitations } = state.pendingElicits

      return {
        ...state,
        pendingElicits: remainingElicitations,
      }
    }

    default:
      return undefined
  }
}
