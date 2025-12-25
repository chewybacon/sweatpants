import { describe, it, expect } from 'vitest'
import { initialChatState, chatReducer } from '../state'
import type { ChatState, ChatPatch } from '../types'

describe('chatReducer (pure logic)', () => {
  it('should handle streaming_start by resetting buffer and active step', () => {
    const startState: ChatState = {
      ...initialChatState,
      messages: [{ id: '1', role: 'user', content: 'hi' }],
      isStreaming: false
    }
    
    const patch: ChatPatch = { type: 'streaming_start' }
    const nextState = chatReducer(startState, patch)
    
    expect(nextState.isStreaming).toBe(true)
    expect(nextState.buffer.settled).toBe('')
    expect(nextState.messages.length).toBe(1)
  })

  it('should clear pendingSteps on streaming_start to prevent stale UI elements', () => {
    // This test documents an important bug fix:
    // When a user sends a new message, any pending steps from the previous
    // request must be cleared. Otherwise, stale UI elements (like input boxes)
    // would persist and appear alongside new ones.
    const staleStep = {
      stepId: 'step-123',
      callId: 'call-abc',
      kind: 'prompt' as const,
      type: 'LocationInput',
      payload: { question: 'Where are you?' },
      element: null,
      timestamp: Date.now(),
      respond: () => {},
    }

    const startState: ChatState = {
      ...initialChatState,
      messages: [{ id: '1', role: 'user', content: 'first message' }],
      isStreaming: false,
      pendingSteps: {
        'step-123': staleStep,
      },
    }
    
    const patch: ChatPatch = { type: 'streaming_start' }
    const nextState = chatReducer(startState, patch)
    
    // pendingSteps must be cleared so old UI components don't appear
    expect(nextState.pendingSteps).toEqual({})
    expect(Object.keys(nextState.pendingSteps)).toHaveLength(0)
  })

  it('should accumulate streaming text', () => {
    const startState: ChatState = {
      ...initialChatState,
      isStreaming: true,
      activeStep: { type: 'text', content: 'Hell' }
    }
    
    const patch: ChatPatch = { type: 'streaming_text', content: 'o' }
    const nextState = chatReducer(startState, patch)
    
    expect(nextState.activeStep?.content).toBe('Hello')
  })

  it('should transition from thinking to text', () => {
    const startState: ChatState = {
      ...initialChatState,
      isStreaming: true,
      activeStep: { type: 'thinking', content: 'Hmmm' },
      currentResponse: []
    }
    
    const patch: ChatPatch = { type: 'streaming_text', content: 'Hi' }
    const nextState = chatReducer(startState, patch)
    
    // Should commit thinking step
    expect(nextState.currentResponse.length).toBe(1)
    expect(nextState.currentResponse[0]).toEqual({ type: 'thinking', content: 'Hmmm' })
    // Should start text step
    expect(nextState.activeStep).toEqual({ type: 'text', content: 'Hi' })
  })

  it('should finalize message on assistant_message', () => {
    const startState: ChatState = {
      ...initialChatState,
      isStreaming: true,
      activeStep: { type: 'text', content: 'Hello world' },
      currentResponse: [{ type: 'thinking', content: 'Thinking' }]
    }
    
    const patch: ChatPatch = { 
      type: 'assistant_message', 
      message: { id: '2', role: 'assistant', content: 'Hello world' } 
    }
    const nextState = chatReducer(startState, patch)
    
    expect(nextState.isStreaming).toBe(true) // streaming_end comes later
    expect(nextState.messages.length).toBe(1)
    
    const msg = nextState.messages[0]
    expect(msg.steps).toHaveLength(2) // Thinking + Text
    expect(msg.content).toBe('Hello world')
    expect(nextState.activeStep).toBeNull()
  })
})
