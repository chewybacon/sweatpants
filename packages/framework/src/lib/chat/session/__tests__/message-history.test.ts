/**
 * Tests for message history handling - specifically ensuring tool_calls
 * and tool_call_id are preserved through the message pipeline.
 * 
 * Bug context: OpenAI provider wasn't seeing tool calls in history because:
 * 1. toApiMessages() was stripping tool_calls and tool_call_id
 * 2. Assistant messages were being stored without their tool_calls
 * 
 * These tests should FAIL until the bugs are fixed.
 */
import { describe, it, expect } from 'vitest'
import { toApiMessages } from '../stream-chat'
import type { Message } from '../../types'

describe('toApiMessages', () => {
  it('should preserve tool_calls on assistant messages', () => {
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
      {
        role: 'tool',
        content: '4',
        tool_call_id: 'call_123',
      },
      { role: 'assistant', content: 'The result is 4.' },
    ]

    const apiMessages = toApiMessages(messages)

    // The assistant message with tool_calls should preserve them
    const assistantWithTools = apiMessages[1]
    expect(assistantWithTools).toBeDefined()
    expect(assistantWithTools!.role).toBe('assistant')
    expect(assistantWithTools!.tool_calls).toBeDefined()
    expect(assistantWithTools!.tool_calls).toHaveLength(1)
    expect(assistantWithTools!.tool_calls![0]!.id).toBe('call_123')
    expect(assistantWithTools!.tool_calls![0]!.function.name).toBe('calculator')
  })

  it('should preserve tool_call_id on tool result messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'What is the weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_weather_456',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: { location: 'NYC' },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: JSON.stringify({ temp: 72, condition: 'sunny' }),
        tool_call_id: 'call_weather_456',
      },
    ]

    const apiMessages = toApiMessages(messages)

    // The tool result message should preserve tool_call_id
    const toolResult = apiMessages[2]
    expect(toolResult).toBeDefined()
    expect(toolResult!.role).toBe('tool')
    expect(toolResult!.tool_call_id).toBe('call_weather_456')
  })

  it('should handle messages without tool fields gracefully', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]

    const apiMessages = toApiMessages(messages)

    // Should not add undefined/null tool_calls
    expect(apiMessages[0]).toEqual({ role: 'user', content: 'Hello' })
    expect(apiMessages[1]).toEqual({ role: 'assistant', content: 'Hi there!' })
    
    // Should not have tool_calls key at all (not even undefined)
    expect('tool_calls' in (apiMessages[0] ?? {})).toBe(false)
    expect('tool_calls' in (apiMessages[1] ?? {})).toBe(false)
  })

  it('should preserve multiple tool_calls in a single assistant message', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Get weather and calculate tip' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: { location: 'NYC' } },
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'calculator', arguments: { expression: '50 * 0.2' } },
          },
        ],
      },
    ]

    const apiMessages = toApiMessages(messages)

    const assistantMsg = apiMessages[1]
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.tool_calls).toHaveLength(2)
    expect(assistantMsg!.tool_calls![0]!.id).toBe('call_1')
    expect(assistantMsg!.tool_calls![1]!.id).toBe('call_2')
  })
})

describe('Message history for multi-turn tool conversations', () => {
  /**
   * This test simulates a tic-tac-toe game flow where:
   * 1. User asks to play
   * 2. LLM calls start_ttt_game tool
   * 3. Tool result comes back
   * 4. User makes a move (via tool interaction)
   * 5. LLM calls ttt_move tool
   * 
   * The bug: when the LLM makes the second call (ttt_move),
   * it doesn't see the first tool call (start_ttt_game) in history,
   * so it doesn't know what moves were made.
   */
  it('should preserve full tool call history across multiple turns', () => {
    const conversationHistory: Message[] = [
      // Turn 1: User asks to play
      { role: 'user', content: "Let's play tic-tac-toe" },
      
      // Turn 1: Assistant calls start_ttt_game
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_start_game',
            type: 'function',
            function: {
              name: 'start_ttt_game',
              arguments: { position: 4 }, // Center
            },
          },
        ],
      },
      
      // Turn 1: Tool result
      {
        role: 'tool',
        content: JSON.stringify({
          board: [null, null, null, null, 'X', null, null, null, null],
          status: 'ongoing',
          userMove: 0, // User clicked position 0
        }),
        tool_call_id: 'call_start_game',
      },
      
      // Turn 2: Assistant responds and calls ttt_move
      {
        role: 'assistant',
        content: 'Good move!',
        tool_calls: [
          {
            id: 'call_move_1',
            type: 'function',
            function: {
              name: 'ttt_move',
              arguments: {
                board: ['O', null, null, null, 'X', null, null, null, null],
                position: 2, // Top right
              },
            },
          },
        ],
      },
    ]

    const apiMessages = toApiMessages(conversationHistory)

    // Verify the first assistant message preserves tool_calls
    expect(apiMessages[1]!.tool_calls).toBeDefined()
    expect(apiMessages[1]!.tool_calls![0]!.function.name).toBe('start_ttt_game')

    // Verify the tool result preserves tool_call_id
    expect(apiMessages[2]!.tool_call_id).toBe('call_start_game')

    // Verify the second assistant message preserves tool_calls
    expect(apiMessages[3]!.tool_calls).toBeDefined()
    expect(apiMessages[3]!.tool_calls![0]!.function.name).toBe('ttt_move')
  })
})
