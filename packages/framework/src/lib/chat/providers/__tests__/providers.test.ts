import { describe, it, expect } from 'vitest'
import { ollamaProvider } from '../ollama'
import { openaiProvider, toOpenAIInput } from '../openai'
import type { Message } from '../../types'

describe('Provider Implementations', () => {
  describe('ollamaProvider', () => {
    it('should have correct capabilities', () => {
      expect(ollamaProvider.name).toBe('ollama')
      expect(ollamaProvider.capabilities).toEqual({
        thinking: true,
        toolCalling: true,
      })
    })

    it('should handle basic streaming setup', () => {
      // Test that the function exists and doesn't throw immediately
      const messages: Message[] = [{ role: 'user', content: 'test' }]
      expect(() => ollamaProvider.stream(messages)).not.toThrow()
    })

    it('should handle messages with tools', () => {
      const messages: Message[] = [{
        role: 'user',
        content: 'test with tools',
        tool_calls: [{
          id: 'test-call',
          type: 'function',
          function: {
            name: 'test_function',
            arguments: { param: 'value' }
          }
        }]
      }]

      // Should not throw on valid message format
      expect(() => ollamaProvider.stream(messages)).not.toThrow()
    })
  })

  describe('openaiProvider', () => {
    it('should have correct capabilities', () => {
      expect(openaiProvider.name).toBe('openai')
      expect(openaiProvider.capabilities).toEqual({
        thinking: true,
        toolCalling: true,
      })
    })

    it('should handle basic streaming setup', () => {
      // Test that the function exists and doesn't throw immediately
      const messages: Message[] = [{ role: 'user', content: 'test' }]
      expect(() => openaiProvider.stream(messages)).not.toThrow()
    })

    it('should handle messages with tools', () => {
      const messages: Message[] = [{
        role: 'user',
        content: 'test with tools',
        tool_calls: [{
          id: 'test-call',
          type: 'function',
          function: {
            name: 'test_function',
            arguments: { param: 'value' }
          }
        }]
      }]

      // Should not throw on valid message format
      expect(() => openaiProvider.stream(messages)).not.toThrow()
    })
  })
})

describe('toOpenAIInput', () => {
  it('should convert simple messages correctly', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]

    const result = toOpenAIInput(messages)

    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ])
  })

  it('should convert system messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'Hello' },
    ]

    const result = toOpenAIInput(messages)

    expect(result).toEqual([
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'Hello' },
    ])
  })

  it('should convert assistant messages with tool_calls to function_call items', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Calculate 2+2' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'calculator',
              arguments: { operation: 'add', a: 2, b: 2 },
            },
          },
        ],
      },
    ]

    const result = toOpenAIInput(messages)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ role: 'user', content: 'Calculate 2+2' })
    
    // The tool_call should be converted to a function_call item
    expect(result[1]).toEqual({
      type: 'function_call',
      call_id: 'call_123',
      name: 'calculator',
      arguments: JSON.stringify({ operation: 'add', a: 2, b: 2 }),
    })
  })

  it('should convert tool result messages to function_call_output items', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        content: '4',
        tool_call_id: 'call_123',
      },
    ]

    const result = toOpenAIInput(messages)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      type: 'function_call_output',
      call_id: 'call_123',
      output: '4',
    })
  })

  it('should handle full tool conversation flow', () => {
    /**
     * This test simulates a tic-tac-toe game flow:
     * 1. User asks to play
     * 2. Assistant calls start_ttt_game tool
     * 3. Tool result comes back
     * 4. Assistant responds with next move
     */
    const messages: Message[] = [
      { role: 'user', content: "Let's play tic-tac-toe" },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_start',
            type: 'function',
            function: {
              name: 'start_ttt_game',
              arguments: { position: 4 },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: JSON.stringify({ board: [null, null, null, null, 'X', null, null, null, null], status: 'ongoing' }),
        tool_call_id: 'call_start',
      },
      { role: 'assistant', content: "I've made my move in the center. Your turn!" },
    ]

    const result = toOpenAIInput(messages)

    expect(result).toHaveLength(4)
    
    // User message
    expect(result[0]).toEqual({ role: 'user', content: "Let's play tic-tac-toe" })
    
    // Assistant tool call -> function_call item
    expect(result[1]).toEqual({
      type: 'function_call',
      call_id: 'call_start',
      name: 'start_ttt_game',
      arguments: JSON.stringify({ position: 4 }),
    })
    
    // Tool result -> function_call_output item  
    expect(result[2]).toEqual({
      type: 'function_call_output',
      call_id: 'call_start',
      output: JSON.stringify({ board: [null, null, null, null, 'X', null, null, null, null], status: 'ongoing' }),
    })
    
    // Final assistant message
    expect(result[3]).toEqual({ role: 'assistant', content: "I've made my move in the center. Your turn!" })
  })

  it('should handle multiple tool calls in a single assistant message', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Let me check both.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: { location: 'NYC' } },
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'get_time', arguments: { timezone: 'EST' } },
          },
        ],
      },
    ]

    const result = toOpenAIInput(messages)

    // Should have: assistant message + 2 function_call items
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ role: 'assistant', content: 'Let me check both.' })
    expect(result[1]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'get_weather',
    })
    expect(result[2]).toMatchObject({
      type: 'function_call',
      call_id: 'call_2',
      name: 'get_time',
    })
  })

  it('should skip tool result messages without tool_call_id', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        content: 'orphaned result',
        // Missing tool_call_id
      },
    ]

    const result = toOpenAIInput(messages)

    // Should be empty - tool result without tool_call_id is skipped
    expect(result).toHaveLength(0)
  })

  it('should handle assistant message with content but no tool_calls', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Just a regular message',
        // No tool_calls
      },
    ]

    const result = toOpenAIInput(messages)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ role: 'assistant', content: 'Just a regular message' })
  })

  it('should handle assistant message with empty content and tool_calls', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '', // Empty content
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'some_tool', arguments: {} },
          },
        ],
      },
    ]

    const result = toOpenAIInput(messages)

    // Should only have the function_call item, not an empty assistant message
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
    })
  })
})
