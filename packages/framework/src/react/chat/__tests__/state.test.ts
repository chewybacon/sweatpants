import { describe, it, expect } from 'vitest'
import { initialChatState, chatReducer } from '../../../lib/chat/state/index.ts'
import type { ChatState, ChatPatch } from '../types.ts'

describe('chatReducer (pure logic)', () => {
  it('should handle streaming_start by resetting streaming parts', () => {
    const startState: ChatState = {
      ...initialChatState,
      messages: [{ id: '1', role: 'user', content: 'hi' }],
      isStreaming: false
    }
    
    const patch: ChatPatch = { type: 'streaming_start' }
    const nextState = chatReducer(startState, patch)
    
    expect(nextState.isStreaming).toBe(true)
    expect(nextState.streaming.parts).toEqual([])
    expect(nextState.streaming.activePartId).toBeNull()
    expect(nextState.streaming.activePartType).toBeNull()
    expect(nextState.messages.length).toBe(1)
  })

  it('should preserve toolEmissions state on streaming_start', () => {
    // Tool emissions are tracked separately and persist across streaming sessions.
    // They're cleaned up when the tool completes via tool_emission_complete patch.
    const startState: ChatState = {
      ...initialChatState,
      messages: [{ id: '1', role: 'user', content: 'first message' }],
      isStreaming: false,
      toolEmissions: {
        'call-123': {
          callId: 'call-123',
          toolName: 'myTool',
          emissions: [],
          status: 'running',
          startedAt: Date.now(),
        },
      },
    }
    
    const patch: ChatPatch = { type: 'streaming_start' }
    const nextState = chatReducer(startState, patch)
    
    // toolEmissions should NOT be cleared - they persist until tool_emission_complete
    expect(nextState.toolEmissions['call-123']).toBeDefined()
  })

  it('should accumulate streaming text into a text part', () => {
    // Start with streaming active, one text part already created
    const startState: ChatState = {
      ...initialChatState,
      isStreaming: true,
      streaming: {
        parts: [{ id: 'part-1', type: 'text', content: 'Hell', rendered: 'Hell' }],
        activePartId: 'part-1',
        activePartType: 'text',
      },
    }
    
    const patch: ChatPatch = { type: 'streaming_text', content: 'o' }
    const nextState = chatReducer(startState, patch)
    
    // Should append to existing text part
    expect(nextState.streaming.parts.length).toBe(1)
    const textPart = nextState.streaming.parts[0]!
    expect(textPart.type).toBe('text')
    expect((textPart as { content: string }).content).toBe('Hello')
  })

  it('should transition from reasoning to text by creating new part', () => {
    // Start with a reasoning part active
    const startState: ChatState = {
      ...initialChatState,
      isStreaming: true,
      streaming: {
        parts: [{ id: 'part-1', type: 'reasoning', content: 'Hmmm', rendered: 'Hmmm' }],
        activePartId: 'part-1',
        activePartType: 'reasoning',
      },
    }
    
    const patch: ChatPatch = { type: 'streaming_text', content: 'Hi' }
    const nextState = chatReducer(startState, patch)
    
    // Should now have two parts: reasoning and text
    expect(nextState.streaming.parts.length).toBe(2)
    
    const reasoningPart = nextState.streaming.parts[0]!
    const textPart = nextState.streaming.parts[1]!
    expect(reasoningPart.type).toBe('reasoning')
    expect((reasoningPart as { content: string }).content).toBe('Hmmm')
    expect(textPart.type).toBe('text')
    expect((textPart as { content: string }).content).toBe('Hi')
    
    // Active part should now be the text part
    expect(nextState.streaming.activePartId).toBe(textPart.id)
    expect(nextState.streaming.activePartType).toBe('text')
  })

  it('should finalize message on assistant_message and streaming_end', () => {
    const startState: ChatState = {
      ...initialChatState,
      isStreaming: true,
      streaming: {
        parts: [
          { id: 'part-1', type: 'reasoning', content: 'Thinking', rendered: 'Thinking' },
          { id: 'part-2', type: 'text', content: 'Hello world', rendered: 'Hello world' },
        ],
        activePartId: 'part-2',
        activePartType: 'text',
      },
    }
    
    // First: assistant_message adds the message but doesn't reset streaming
    const assistantPatch: ChatPatch = { 
      type: 'assistant_message', 
      message: { id: 'msg-2', role: 'assistant', content: 'Hello world' } 
    }
    const afterAssistant = chatReducer(startState, assistantPatch)
    
    // Message should be added
    expect(afterAssistant.messages.length).toBe(1)
    expect(afterAssistant.messages[0]!.content).toBe('Hello world')
    
    // Streaming state is NOT yet reset (parts still there for streaming_end to capture)
    expect(afterAssistant.streaming.parts.length).toBe(2)
    
    // Second: streaming_end finalizes parts and resets streaming state
    const endPatch: ChatPatch = { type: 'streaming_end' }
    const nextState = chatReducer(afterAssistant, endPatch)
    
    // Streaming state should now be reset
    expect(nextState.streaming.parts).toEqual([])
    expect(nextState.streaming.activePartId).toBeNull()
    expect(nextState.streaming.activePartType).toBeNull()
    expect(nextState.isStreaming).toBe(false)
    
    // Finalized parts should be saved
    expect(nextState.finalizedParts['msg-2']).toBeDefined()
    expect(nextState.finalizedParts['msg-2']!.length).toBe(2)
  })
})
