/**
 * Emission Reducer Integration Tests
 *
 * Tests the flow: emission patches → state reducer → toolEmissions state
 *
 * This validates that the emission primitives correctly update React state
 * through the patch/reducer pattern.
 */
import { describe, it, expect } from 'vitest'
import { chatReducer, initialChatState } from '../state'
import type { ChatState } from '../types'
import type {
  ToolEmissionStartPatch,
  ToolEmissionPatch,
  ToolEmissionResponsePatch,
  ToolEmissionCompletePatch,
} from '../../../lib/chat/patches'

describe('Emission Reducer', () => {
  describe('tool_emission_start', () => {
    it('should create a new emission tracking state', () => {
      const patch: ToolEmissionStartPatch = {
        type: 'tool_emission_start',
        callId: 'call-123',
        toolName: 'myTool',
      }

      const state = chatReducer(initialChatState, patch)

      expect(state.toolEmissions['call-123']).toBeDefined()
      expect(state.toolEmissions['call-123']!.callId).toBe('call-123')
      expect(state.toolEmissions['call-123']!.toolName).toBe('myTool')
      expect(state.toolEmissions['call-123']!.status).toBe('running')
      expect(state.toolEmissions['call-123']!.emissions).toHaveLength(0)
    })
  })

  describe('tool_emission', () => {
    it('should add emission to existing tracking state', () => {
      // Start with a tracking state
      let state: ChatState = chatReducer(initialChatState, {
        type: 'tool_emission_start',
        callId: 'call-123',
        toolName: 'myTool',
      })

      // Add an emission
      const respondFn = () => {}
      const patch: ToolEmissionPatch = {
        type: 'tool_emission',
        callId: 'call-123',
        emission: {
          id: 'em-1',
          type: '__component__',
          payload: {
            componentKey: 'AskQuestion',
            props: { question: 'Do you agree?' },
          },
          status: 'pending',
          timestamp: Date.now(),
        },
        respond: respondFn,
      }

      state = chatReducer(state, patch)

      expect(state.toolEmissions['call-123']!.emissions).toHaveLength(1)
      expect(state.toolEmissions['call-123']!.emissions[0]!.id).toBe('em-1')
      expect(state.toolEmissions['call-123']!.emissions[0]!.status).toBe('pending')
      expect(state.toolEmissions['call-123']!.emissions[0]!.respond).toBe(respondFn)
    })

    it('should auto-create tracking state if not started', () => {
      const respondFn = () => {}
      const patch: ToolEmissionPatch = {
        type: 'tool_emission',
        callId: 'call-456',
        emission: {
          id: 'em-1',
          type: '__component__',
          payload: {
            componentKey: 'Widget',
            props: {},
          },
          status: 'pending',
          timestamp: Date.now(),
        },
        respond: respondFn,
      }

      const state = chatReducer(initialChatState, patch)

      expect(state.toolEmissions['call-456']).toBeDefined()
      expect(state.toolEmissions['call-456']!.status).toBe('running')
      expect(state.toolEmissions['call-456']!.emissions).toHaveLength(1)
    })
  })

  describe('tool_emission_response', () => {
    it('should mark emission as complete and remove respond callback', () => {
      // Set up initial state with a pending emission
      let state: ChatState = chatReducer(initialChatState, {
        type: 'tool_emission_start',
        callId: 'call-123',
        toolName: 'myTool',
      })

      const respondFn = () => {}
      state = chatReducer(state, {
        type: 'tool_emission',
        callId: 'call-123',
        emission: {
          id: 'em-1',
          type: '__component__',
          payload: { componentKey: 'Widget', props: {} },
          status: 'pending',
          timestamp: Date.now(),
        },
        respond: respondFn,
      })

      // Now send response
      const responsePatch: ToolEmissionResponsePatch = {
        type: 'tool_emission_response',
        callId: 'call-123',
        emissionId: 'em-1',
        response: { answer: 'yes' },
      }

      state = chatReducer(state, responsePatch)

      const emission = state.toolEmissions['call-123']!.emissions[0]!
      expect(emission.status).toBe('complete')
      expect(emission.response).toEqual({ answer: 'yes' })
      expect(emission.respond).toBeUndefined() // Respond callback removed
    })

    it('should not modify other emissions', () => {
      let state: ChatState = chatReducer(initialChatState, {
        type: 'tool_emission_start',
        callId: 'call-123',
        toolName: 'myTool',
      })

      // Add two emissions
      const respond1 = () => {}
      const respond2 = () => {}
      state = chatReducer(state, {
        type: 'tool_emission',
        callId: 'call-123',
        emission: {
          id: 'em-1',
          type: '__component__',
          payload: { componentKey: 'Widget1', props: {} },
          status: 'pending',
          timestamp: Date.now(),
        },
        respond: respond1,
      })
      state = chatReducer(state, {
        type: 'tool_emission',
        callId: 'call-123',
        emission: {
          id: 'em-2',
          type: '__component__',
          payload: { componentKey: 'Widget2', props: {} },
          status: 'pending',
          timestamp: Date.now(),
        },
        respond: respond2,
      })

      // Respond to first emission only
      state = chatReducer(state, {
        type: 'tool_emission_response',
        callId: 'call-123',
        emissionId: 'em-1',
        response: 'result1',
      })

      // First emission should be complete
      expect(state.toolEmissions['call-123']!.emissions[0]!.status).toBe('complete')
      expect(state.toolEmissions['call-123']!.emissions[0]!.respond).toBeUndefined()

      // Second emission should still be pending
      expect(state.toolEmissions['call-123']!.emissions[1]!.status).toBe('pending')
      expect(state.toolEmissions['call-123']!.emissions[1]!.respond).toBe(respond2)
    })
  })

  describe('tool_emission_complete', () => {
    it('should remove tracking state from toolEmissions', () => {
      let state: ChatState = chatReducer(initialChatState, {
        type: 'tool_emission_start',
        callId: 'call-123',
        toolName: 'myTool',
      })

      // Complete the emission
      const completePatch: ToolEmissionCompletePatch = {
        type: 'tool_emission_complete',
        callId: 'call-123',
        result: 'final result',
      }

      state = chatReducer(state, completePatch)

      expect(state.toolEmissions['call-123']).toBeUndefined()
    })

    it('should preserve other tool emissions', () => {
      let state: ChatState = chatReducer(initialChatState, {
        type: 'tool_emission_start',
        callId: 'call-1',
        toolName: 'tool1',
      })
      state = chatReducer(state, {
        type: 'tool_emission_start',
        callId: 'call-2',
        toolName: 'tool2',
      })

      // Complete only call-1
      state = chatReducer(state, {
        type: 'tool_emission_complete',
        callId: 'call-1',
      })

      expect(state.toolEmissions['call-1']).toBeUndefined()
      expect(state.toolEmissions['call-2']).toBeDefined()
    })
  })

  describe('full emission lifecycle', () => {
    it('should handle multiple emissions with sequential responses', () => {
      const responses: string[] = []
      let state = initialChatState

      // Start tracking
      state = chatReducer(state, {
        type: 'tool_emission_start',
        callId: 'call-1',
        toolName: 'multistepTool',
      })

      // First emission
      state = chatReducer(state, {
        type: 'tool_emission',
        callId: 'call-1',
        emission: {
          id: 'em-1',
          type: '__component__',
          payload: { componentKey: 'Step1', props: { n: 1 } },
          status: 'pending',
          timestamp: 1000,
        },
        respond: (v) => responses.push(`em-1: ${v}`),
      })

      expect(state.toolEmissions['call-1']!.emissions).toHaveLength(1)

      // Response to first
      state = chatReducer(state, {
        type: 'tool_emission_response',
        callId: 'call-1',
        emissionId: 'em-1',
        response: 'done1',
      })

      // Second emission
      state = chatReducer(state, {
        type: 'tool_emission',
        callId: 'call-1',
        emission: {
          id: 'em-2',
          type: '__component__',
          payload: { componentKey: 'Step2', props: { n: 2 } },
          status: 'pending',
          timestamp: 2000,
        },
        respond: (v) => responses.push(`em-2: ${v}`),
      })

      expect(state.toolEmissions['call-1']!.emissions).toHaveLength(2)
      expect(state.toolEmissions['call-1']!.emissions[0]!.status).toBe('complete')
      expect(state.toolEmissions['call-1']!.emissions[1]!.status).toBe('pending')

      // Response to second
      state = chatReducer(state, {
        type: 'tool_emission_response',
        callId: 'call-1',
        emissionId: 'em-2',
        response: 'done2',
      })

      // Both complete
      expect(state.toolEmissions['call-1']!.emissions[0]!.status).toBe('complete')
      expect(state.toolEmissions['call-1']!.emissions[1]!.status).toBe('complete')

      // Tool completes
      state = chatReducer(state, {
        type: 'tool_emission_complete',
        callId: 'call-1',
        result: 'all done',
      })

      expect(state.toolEmissions['call-1']).toBeUndefined()
    })

    it('should support concurrent tools with emissions', () => {
      let state = initialChatState

      // Start two tools
      state = chatReducer(state, {
        type: 'tool_emission_start',
        callId: 'tool-a',
        toolName: 'toolA',
      })
      state = chatReducer(state, {
        type: 'tool_emission_start',
        callId: 'tool-b',
        toolName: 'toolB',
      })

      // Each emits
      state = chatReducer(state, {
        type: 'tool_emission',
        callId: 'tool-a',
        emission: {
          id: 'a-em-1',
          type: '__component__',
          payload: { componentKey: 'WidgetA', props: {} },
          status: 'pending',
          timestamp: 1000,
        },
        respond: () => {},
      })
      state = chatReducer(state, {
        type: 'tool_emission',
        callId: 'tool-b',
        emission: {
          id: 'b-em-1',
          type: '__component__',
          payload: { componentKey: 'WidgetB', props: {} },
          status: 'pending',
          timestamp: 1001,
        },
        respond: () => {},
      })

      expect(state.toolEmissions['tool-a']!.emissions).toHaveLength(1)
      expect(state.toolEmissions['tool-b']!.emissions).toHaveLength(1)

      // Tool B completes first
      state = chatReducer(state, {
        type: 'tool_emission_response',
        callId: 'tool-b',
        emissionId: 'b-em-1',
        response: 'b-done',
      })
      state = chatReducer(state, {
        type: 'tool_emission_complete',
        callId: 'tool-b',
      })

      expect(state.toolEmissions['tool-b']).toBeUndefined()
      expect(state.toolEmissions['tool-a']).toBeDefined()
      expect(state.toolEmissions['tool-a']!.emissions[0]!.status).toBe('pending')
    })
  })
})
