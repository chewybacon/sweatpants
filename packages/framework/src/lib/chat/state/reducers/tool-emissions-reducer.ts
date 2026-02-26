/**
 * lib/chat/state/reducers/tool-emissions-reducer.ts
 */
import type { ChatState, ToolEmissionState, ToolEmissionTrackingState } from '../chat-state.ts'
import type { ChatPatch } from '../../patches/index.ts'

export function reduceToolEmissions(state: ChatState, patch: ChatPatch): ChatState | undefined {
  switch (patch.type) {
    case 'tool_emission_start':
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

    case 'tool_emission': {
      const tracking = state.toolEmissions[patch.callId]
      const toolName = tracking?.toolName ?? patch.toolName ?? ''

      const newEmission: ToolEmissionState = {
        ...patch.emission,
        callId: patch.callId,
        toolName,
      }
      if (patch.respond) {
        newEmission.respond = patch.respond
      }

      if (!tracking) {
        return {
          ...state,
          toolEmissions: {
            ...state.toolEmissions,
            [patch.callId]: {
              callId: patch.callId,
              toolName,
              emissions: [newEmission],
              status: 'running',
              startedAt: Date.now(),
            },
          },
        }
      }

      return {
        ...state,
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
            emissions: tracking.emissions.map((e) => {
              if (e.id !== patch.emissionId) return e
              const updated: ToolEmissionState = {
                id: e.id,
                callId: e.callId,
                toolName: e.toolName,
                type: e.type,
                payload: e.payload,
                status: 'complete',
                response: patch.response,
                timestamp: e.timestamp,
              }
              if (e.error) updated.error = e.error
              return updated
            }),
          },
        },
      }
    }

    case 'tool_emission_complete': {
      const tracking = state.toolEmissions[patch.callId]
      if (!tracking) {
        return state
      }

      const updated: ToolEmissionTrackingState = {
        callId: tracking.callId,
        toolName: tracking.toolName,
        emissions: tracking.emissions,
        status: patch.error ? 'error' : 'complete',
        startedAt: tracking.startedAt,
        completedAt: Date.now(),
      }
      if (patch.result !== undefined) updated.result = patch.result
      if (patch.error) updated.error = patch.error

      return {
        ...state,
        toolEmissions: {
          ...state.toolEmissions,
          [patch.callId]: updated,
        },
      }
    }

    default:
      return undefined
  }
}
