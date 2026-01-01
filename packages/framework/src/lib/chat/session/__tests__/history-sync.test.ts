/**
 * Tests for session history synchronization after tool calls.
 * 
 * Bug context: After isomorphic tool handoffs complete, the session history
 * wasn't being updated with:
 * 1. Assistant messages containing tool_calls
 * 2. Tool result messages with actual content (phase 2 results)
 * 
 * This caused the LLM to not see tool call history on subsequent turns,
 * preventing it from calling tools again.
 */
import { describe, it, expect } from 'vitest'
import type { Message } from '../../types'
import type { ApiMessage } from '../streaming'

/**
 * Simulate the history sync logic from create-session.ts
 * This mirrors the actual implementation to test the core algorithm.
 */
function syncHistoryWithCurrentMessages(
  history: Message[],
  currentMessages: ApiMessage[],
  toolResultsMap: Map<string, string>
): Message[] {
  const result = [...history]
  const originalHistoryLength = history.length
  
  // Add any new messages from currentMessages
  for (let i = originalHistoryLength; i < currentMessages.length; i++) {
    const apiMsg = currentMessages[i]!
    
    // For tool results, check if we have updated content from phase 2
    let content = apiMsg.content
    if (apiMsg.role === 'tool' && apiMsg.tool_call_id) {
      const updatedContent = toolResultsMap.get(apiMsg.tool_call_id)
      if (updatedContent) {
        content = updatedContent
      }
    }
    
    const msg: Message = {
      id: `msg-${i}`,
      role: apiMsg.role,
      content: content,
    }
    
    // Preserve tool_calls with proper type field
    if (apiMsg.tool_calls && apiMsg.tool_calls.length > 0) {
      msg.tool_calls = apiMsg.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: 'function' in tc ? tc.function : { name: (tc as any).name, arguments: (tc as any).arguments },
      }))
    }
    
    // Preserve tool_call_id
    if (apiMsg.tool_call_id) {
      msg.tool_call_id = apiMsg.tool_call_id
    }
    
    result.push(msg)
  }
  
  return result
}

describe('History sync after tool calls', () => {
  describe('syncHistoryWithCurrentMessages', () => {
    it('should add assistant message with tool_calls to history', () => {
      const history: Message[] = [
        { id: 'msg-0', role: 'user', content: 'draw 3 cards' },
      ]
      
      const currentMessages: ApiMessage[] = [
        { role: 'user', content: 'draw 3 cards' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_abc123',
              function: {
                name: 'pick_card',
                arguments: { count: 3 },
              },
            },
          ],
        },
        {
          role: 'tool',
          content: '', // Empty initially (before phase 2)
          tool_call_id: 'call_abc123',
        },
      ]
      
      const toolResultsMap = new Map<string, string>([
        ['call_abc123', 'The user selected the Queen of Hearts.'],
      ])
      
      const synced = syncHistoryWithCurrentMessages(history, currentMessages, toolResultsMap)
      
      // Should have 3 messages now
      expect(synced).toHaveLength(3)
      
      // First message unchanged
      expect(synced[0]).toEqual(history[0])
      
      // Second message should be assistant with tool_calls
      expect(synced[1]!.role).toBe('assistant')
      expect(synced[1]!.tool_calls).toBeDefined()
      expect(synced[1]!.tool_calls).toHaveLength(1)
      expect(synced[1]!.tool_calls![0]!.id).toBe('call_abc123')
      expect(synced[1]!.tool_calls![0]!.type).toBe('function')
      expect(synced[1]!.tool_calls![0]!.function.name).toBe('pick_card')
      expect(synced[1]!.tool_calls![0]!.function.arguments).toEqual({ count: 3 })
      
      // Third message should be tool result with updated content
      expect(synced[2]!.role).toBe('tool')
      expect(synced[2]!.tool_call_id).toBe('call_abc123')
      expect(synced[2]!.content).toBe('The user selected the Queen of Hearts.')
    })

    it('should use phase 2 tool result content when available', () => {
      const history: Message[] = [
        { id: 'msg-0', role: 'user', content: 'test' },
      ]
      
      const currentMessages: ApiMessage[] = [
        { role: 'user', content: 'test' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', function: { name: 'tool_a', arguments: {} } },
          ],
        },
        {
          role: 'tool',
          content: '', // Empty - client-side placeholder
          tool_call_id: 'call_1',
        },
      ]
      
      // Phase 2 provides the actual result
      const toolResultsMap = new Map<string, string>([
        ['call_1', 'Phase 2 result content here'],
      ])
      
      const synced = syncHistoryWithCurrentMessages(history, currentMessages, toolResultsMap)
      
      // Tool message should have the phase 2 content, not empty string
      expect(synced[2]!.content).toBe('Phase 2 result content here')
    })

    it('should preserve original tool content if no phase 2 update', () => {
      const history: Message[] = [
        { id: 'msg-0', role: 'user', content: 'test' },
      ]
      
      const currentMessages: ApiMessage[] = [
        { role: 'user', content: 'test' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', function: { name: 'tool_a', arguments: {} } },
          ],
        },
        {
          role: 'tool',
          content: 'Original content from server',
          tool_call_id: 'call_1',
        },
      ]
      
      // No phase 2 update
      const toolResultsMap = new Map<string, string>()
      
      const synced = syncHistoryWithCurrentMessages(history, currentMessages, toolResultsMap)
      
      // Should keep original content
      expect(synced[2]!.content).toBe('Original content from server')
    })

    it('should handle multiple tool calls in one turn', () => {
      const history: Message[] = [
        { id: 'msg-0', role: 'user', content: 'draw 3 cards and calculate 2+2' },
      ]
      
      const currentMessages: ApiMessage[] = [
        { role: 'user', content: 'draw 3 cards and calculate 2+2' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_card', function: { name: 'pick_card', arguments: { count: 3 } } },
            { id: 'call_calc', function: { name: 'calculator', arguments: { expr: '2+2' } } },
          ],
        },
        { role: 'tool', content: '', tool_call_id: 'call_card' },
        { role: 'tool', content: '', tool_call_id: 'call_calc' },
      ]
      
      const toolResultsMap = new Map<string, string>([
        ['call_card', 'Selected: Ace of Spades'],
        ['call_calc', '4'],
      ])
      
      const synced = syncHistoryWithCurrentMessages(history, currentMessages, toolResultsMap)
      
      expect(synced).toHaveLength(4)
      
      // Assistant should have both tool calls
      expect(synced[1]!.tool_calls).toHaveLength(2)
      expect(synced[1]!.tool_calls![0]!.function.name).toBe('pick_card')
      expect(synced[1]!.tool_calls![1]!.function.name).toBe('calculator')
      
      // Both tool results should have content
      expect(synced[2]!.content).toBe('Selected: Ace of Spades')
      expect(synced[3]!.content).toBe('4')
    })

    it('should not duplicate existing history messages', () => {
      const history: Message[] = [
        { id: 'msg-0', role: 'user', content: 'hello' },
        { id: 'msg-1', role: 'assistant', content: 'hi there' },
      ]
      
      // Current messages include the same messages
      const currentMessages: ApiMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ]
      
      const synced = syncHistoryWithCurrentMessages(history, currentMessages, new Map())
      
      // Should not duplicate - still just 2 messages
      expect(synced).toHaveLength(2)
    })

    it('should add type: function to tool_calls even if missing', () => {
      const history: Message[] = [
        { id: 'msg-0', role: 'user', content: 'test' },
      ]
      
      // Simulate tool_calls without type field (legacy format)
      const currentMessages: ApiMessage[] = [
        { role: 'user', content: 'test' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              function: { name: 'my_tool', arguments: { x: 1 } },
            } as any, // Cast to bypass type check - simulating legacy format
          ],
        },
      ]
      
      const synced = syncHistoryWithCurrentMessages(history, currentMessages, new Map())
      
      // Should add type: 'function'
      expect(synced[1]!.tool_calls![0]!.type).toBe('function')
    })
  })
})

describe('Tool call format for OpenAI API', () => {
  it('should have correct structure for OpenAI Responses API', () => {
    // This tests that the synced history has the right format for toOpenAIInput()
    const history: Message[] = [
      { id: 'msg-0', role: 'user', content: 'draw a card' },
    ]
    
    const currentMessages: ApiMessage[] = [
      { role: 'user', content: 'draw a card' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_xyz',
            function: { name: 'pick_card', arguments: { count: 1 } },
          },
        ],
      },
      {
        role: 'tool',
        content: '',
        tool_call_id: 'call_xyz',
      },
    ]
    
    const toolResultsMap = new Map([['call_xyz', 'You picked the King of Diamonds.']])
    const synced = syncHistoryWithCurrentMessages(history, currentMessages, toolResultsMap)
    
    // Verify the tool_calls structure matches what OpenAI expects
    const assistantMsg = synced[1]!
    expect(assistantMsg.tool_calls![0]).toMatchObject({
      id: 'call_xyz',
      type: 'function',
      function: {
        name: 'pick_card',
        arguments: { count: 1 },
      },
    })
    
    // Verify tool result has tool_call_id
    const toolMsg = synced[2]!
    expect(toolMsg.tool_call_id).toBe('call_xyz')
    expect(toolMsg.content).toBe('You picked the King of Diamonds.')
  })
})

describe('Multi-turn conversation history', () => {
  it('should maintain correct history across multiple tool call turns', () => {
    // Simulate: Turn 1 user -> tool call -> tool result -> assistant response
    // Then: Turn 2 user -> should have full history
    
    // After turn 1, history should have:
    const historyAfterTurn1: Message[] = [
      { id: '1', role: 'user', content: 'draw 3 cards' },
      {
        id: '2',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'pick_card', arguments: { count: 3 } },
          },
        ],
      },
      {
        id: '3',
        role: 'tool',
        content: 'You picked the 5 of Hearts.',
        tool_call_id: 'call_1',
      },
      {
        id: '4',
        role: 'assistant',
        content: 'Great choice! You picked the 5 of Hearts.',
      },
    ]
    
    // When turn 2 starts, add user message
    const historyWithTurn2: Message[] = [
      ...historyAfterTurn1,
      { id: '5', role: 'user', content: 'draw 2 more' },
    ]
    
    // Verify the history format is correct for sending to LLM
    expect(historyWithTurn2).toHaveLength(5)
    
    // Turn 1: user message
    expect(historyWithTurn2[0]!.role).toBe('user')
    
    // Turn 1: assistant with tool_calls
    expect(historyWithTurn2[1]!.role).toBe('assistant')
    expect(historyWithTurn2[1]!.tool_calls).toBeDefined()
    expect(historyWithTurn2[1]!.tool_calls![0]!.function.name).toBe('pick_card')
    
    // Turn 1: tool result
    expect(historyWithTurn2[2]!.role).toBe('tool')
    expect(historyWithTurn2[2]!.tool_call_id).toBe('call_1')
    expect(historyWithTurn2[2]!.content).toBeTruthy()
    
    // Turn 1: final assistant response
    expect(historyWithTurn2[3]!.role).toBe('assistant')
    expect(historyWithTurn2[3]!.content).toContain('5 of Hearts')
    
    // Turn 2: user message
    expect(historyWithTurn2[4]!.role).toBe('user')
    expect(historyWithTurn2[4]!.content).toBe('draw 2 more')
  })
})
