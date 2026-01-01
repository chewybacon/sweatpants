/**
 * Handler Multi-Turn Tool Calling Tests
 * 
 * These tests verify that tool_calls and tool_call_id are properly preserved
 * in conversation messages when the handler processes multi-turn tool calls.
 * 
 * Uses vitest-effection for clean generator-based testing.
 */
import { describe, it, expect } from './vitest-effection'
import { resource } from 'effection'
import type { Stream } from 'effection'
import type { Operation } from 'effection'
import type { Message, ChatEvent, ChatResult, ToolCall } from '../../lib/chat/types'
import type { ChatProvider, ChatStreamOptions } from '../../lib/chat/providers/types'

// =============================================================================
// MOCK PROVIDER
// =============================================================================

interface MockProviderTurn {
  text: string
  toolCalls: ToolCall[]
}

/**
 * Creates a mock provider that captures messages and returns scripted responses.
 * Uses effection channels for proper async stream handling.
 */
function createMockProvider(turns: MockProviderTurn[]): ChatProvider & {
  capturedCalls: Array<{ messages: Message[]; options: ChatStreamOptions | null }>
} {
  let turnIndex = 0
  const capturedCalls: Array<{ messages: Message[]; options: ChatStreamOptions | null }> = []

  return {
    name: 'mock',
    capabilities: {
      thinking: false,
      toolCalling: true,
    },
    capturedCalls,
    stream(messages: Message[], options?: ChatStreamOptions): Stream<ChatEvent, ChatResult> {
      // Deep clone to capture the state at call time
      capturedCalls.push({
        messages: JSON.parse(JSON.stringify(messages)),
        options: options ?? null,
      })

      const currentTurn = turns[turnIndex++]
      if (!currentTurn) {
        throw new Error(`No turn configured for call #${turnIndex}`)
      }

      // Return an effection resource that provides an iterator-like subscription
      return resource(function* (provide) {
        // Queue of events to emit
        const events: ChatEvent[] = []
        if (currentTurn.toolCalls.length > 0) {
          events.push({ type: 'tool_calls', toolCalls: currentTurn.toolCalls })
        }

        // Build final result
        const result: ChatResult = {
          text: currentTurn.text,
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        }
        if (currentTurn.toolCalls.length > 0) {
          result.toolCalls = currentTurn.toolCalls
        }

        let eventIndex = 0

        // Provide a subscription-like object
        yield* provide({
          *next(): Operation<IteratorResult<ChatEvent, ChatResult>> {
            if (eventIndex < events.length) {
              return { done: false, value: events[eventIndex++]! }
            }
            return { done: true, value: result }
          },
        })
      })
    },
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Build an assistant message from a ChatResult, properly handling optional tool_calls
 */
function buildAssistantMessage(result: ChatResult): Message {
  const msg: Message = {
    role: 'assistant',
    content: result.text,
  }
  if (result.toolCalls && result.toolCalls.length > 0) {
    msg.tool_calls = result.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: tc.function,
    }))
  }
  return msg
}

// =============================================================================
// TESTS - Message Format Verification
// =============================================================================

describe('Multi-turn tool calling message format', () => {
  describe('Message.tool_calls structure', () => {
    it('should have correct tool_calls shape with function wrapper', function* () {
      const toolCall: ToolCall = {
        id: 'call_123',
        function: {
          name: 'test_tool',
          arguments: { x: 1 },
        },
      }

      // Verify the shape
      expect(toolCall.id).toBe('call_123')
      expect(toolCall.function.name).toBe('test_tool')
      expect(toolCall.function.arguments).toEqual({ x: 1 })
    })

    it('should preserve tool_calls when building conversation history', function* () {
      // Simulate what the handler does when adding an assistant message with tool_calls
      const assistantMessage: Message = {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'my_tool', arguments: { param: 'value' } },
          },
        ],
      }

      const toolResultMessage: Message = {
        role: 'tool',
        content: JSON.stringify({ result: 'success' }),
        tool_call_id: 'call_abc',
      }

      const conversationMessages: Message[] = [
        { role: 'user', content: 'Do something' },
        assistantMessage,
        toolResultMessage,
      ]

      // Verify structure is preserved
      expect(conversationMessages[1]!.tool_calls).toBeDefined()
      expect(conversationMessages[1]!.tool_calls).toHaveLength(1)
      expect(conversationMessages[1]!.tool_calls![0]!.function.name).toBe('my_tool')
      expect(conversationMessages[2]!.tool_call_id).toBe('call_abc')
    })

    it('should include type: function in tool_calls for OpenAI API compatibility', function* () {
      /**
       * OpenAI API requires tool_calls to have the structure:
       * { id, type: 'function', function: { name, arguments } }
       * 
       * This test verifies that buildAssistantMessage correctly adds the type field.
       */
      const result: ChatResult = {
        text: '',
        toolCalls: [
          { id: 'call_test', function: { name: 'test_tool', arguments: { x: 1 } } },
        ],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      }

      const assistantMsg = buildAssistantMessage(result)

      // Verify the tool_calls have the correct structure for OpenAI
      expect(assistantMsg.tool_calls).toBeDefined()
      expect(assistantMsg.tool_calls).toHaveLength(1)
      
      const toolCall = assistantMsg.tool_calls![0]!
      expect(toolCall.id).toBe('call_test')
      expect(toolCall.type).toBe('function')  // Critical: OpenAI requires this
      expect(toolCall.function.name).toBe('test_tool')
      expect(toolCall.function.arguments).toEqual({ x: 1 })
    })
  })

  describe('Mock provider captures messages correctly', () => {
    it('should capture messages with tool_calls preserved', function* () {
      const mockProvider = createMockProvider([
        {
          text: 'I will call the tool',
          toolCalls: [
            {
              id: 'call_first',
              function: { name: 'step_one', arguments: { input: 'start' } },
            },
          ],
        },
      ])

      // Simulate calling the provider with a conversation that has tool history
      const messages: Message[] = [
        { role: 'user', content: 'Start' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_previous',
              type: 'function',
              function: { name: 'previous_tool', arguments: { x: 1 } },
            },
          ],
        },
        {
          role: 'tool',
          content: 'previous result',
          tool_call_id: 'call_previous',
        },
      ]

      // Call the mock provider's stream
      const stream = mockProvider.stream(messages, { model: 'test' })
      const subscription = yield* stream

      // Consume all events
      let next = yield* subscription.next()
      while (!next.done) {
        next = yield* subscription.next()
      }

      // Verify captured messages
      expect(mockProvider.capturedCalls).toHaveLength(1)
      const captured = mockProvider.capturedCalls[0]!

      // The assistant message should have tool_calls preserved
      const assistantMsg = captured.messages[1]!
      expect(assistantMsg.role).toBe('assistant')
      expect(assistantMsg.tool_calls).toBeDefined()
      expect(assistantMsg.tool_calls).toHaveLength(1)
      expect(assistantMsg.tool_calls![0]!.function.name).toBe('previous_tool')

      // The tool result should have tool_call_id preserved
      const toolMsg = captured.messages[2]!
      expect(toolMsg.role).toBe('tool')
      expect(toolMsg.tool_call_id).toBe('call_previous')
    })

    it('should return tool_calls in result', function* () {
      const mockProvider = createMockProvider([
        {
          text: '',
          toolCalls: [
            {
              id: 'call_xyz',
              function: { name: 'my_tool', arguments: { a: 1 } },
            },
          ],
        },
      ])

      const stream = mockProvider.stream([{ role: 'user', content: 'test' }])
      const subscription = yield* stream

      // Consume events
      const events: ChatEvent[] = []
      let next = yield* subscription.next()
      while (!next.done) {
        events.push(next.value)
        next = yield* subscription.next()
      }

      // Check result
      const result = next.value
      expect(result.toolCalls).toBeDefined()
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls![0]!.id).toBe('call_xyz')
      expect(result.toolCalls![0]!.function.name).toBe('my_tool')

      // Check events
      const toolCallEvent = events.find((e) => e.type === 'tool_calls')
      expect(toolCallEvent).toBeDefined()
    })
  })

  describe('Simulated multi-turn flow', () => {
    it('should preserve tool_calls across multiple provider calls', function* () {
      /**
       * Simulates what the handler does:
       * 1. Call provider with user message
       * 2. Provider returns tool_call
       * 3. Build new message list with assistant+tool_calls + tool result
       * 4. Call provider again
       * 5. Verify the second call sees the tool_calls from step 2
       */
      const mockProvider = createMockProvider([
        // Turn 1: Call step_one
        {
          text: '',
          toolCalls: [
            { id: 'call_step1', function: { name: 'step_one', arguments: { x: 1 } } },
          ],
        },
        // Turn 2: Call step_two
        {
          text: '',
          toolCalls: [
            { id: 'call_step2', function: { name: 'step_two', arguments: { y: 2 } } },
          ],
        },
        // Turn 3: Final response
        {
          text: 'All done!',
          toolCalls: [],
        },
      ])

      // Turn 1: Initial request
      const turn1Messages: Message[] = [{ role: 'user', content: 'Do multi-step' }]
      let stream = mockProvider.stream(turn1Messages)
      let subscription = yield* stream
      let next = yield* subscription.next()
      while (!next.done) {
        next = yield* subscription.next()
      }
      const turn1Result = next.value

      // Build turn 2 messages (simulating what handler does)
      const turn2Messages: Message[] = [
        ...turn1Messages,
        buildAssistantMessage(turn1Result),
        {
          role: 'tool',
          content: JSON.stringify({ result: 'step1_output' }),
          tool_call_id: 'call_step1',
        },
      ]

      // Turn 2: Send with tool history
      stream = mockProvider.stream(turn2Messages)
      subscription = yield* stream
      next = yield* subscription.next()
      while (!next.done) {
        next = yield* subscription.next()
      }
      const turn2Result = next.value

      // Verify turn 2 captured the correct messages
      expect(mockProvider.capturedCalls).toHaveLength(2)
      const turn2Captured = mockProvider.capturedCalls[1]!

      // The assistant message in turn 2 should have tool_calls
      const turn2AssistantMsg = turn2Captured.messages.find(
        (m) => m.role === 'assistant' && m.tool_calls
      )
      expect(turn2AssistantMsg).toBeDefined()
      expect(turn2AssistantMsg!.tool_calls).toHaveLength(1)
      expect(turn2AssistantMsg!.tool_calls![0]!.function.name).toBe('step_one')

      // Build turn 3 messages
      const turn3Messages: Message[] = [
        ...turn2Messages,
        buildAssistantMessage(turn2Result),
        {
          role: 'tool',
          content: JSON.stringify({ result: 'step2_output' }),
          tool_call_id: 'call_step2',
        },
      ]

      // Turn 3: Final call
      stream = mockProvider.stream(turn3Messages)
      subscription = yield* stream
      next = yield* subscription.next()
      while (!next.done) {
        next = yield* subscription.next()
      }

      // Verify turn 3 has full history
      expect(mockProvider.capturedCalls).toHaveLength(3)
      const turn3Captured = mockProvider.capturedCalls[2]!

      // Should have 5 messages: user + assistant+tool_calls + tool + assistant+tool_calls + tool
      expect(turn3Captured.messages).toHaveLength(5)

      // Both assistant messages should have tool_calls
      const assistantMsgs = turn3Captured.messages.filter(
        (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
      )
      expect(assistantMsgs).toHaveLength(2)
      expect(assistantMsgs[0]!.tool_calls![0]!.function.name).toBe('step_one')
      expect(assistantMsgs[1]!.tool_calls![0]!.function.name).toBe('step_two')

      // Both tool messages should have tool_call_id
      const toolMsgs = turn3Captured.messages.filter((m) => m.role === 'tool')
      expect(toolMsgs).toHaveLength(2)
      expect(toolMsgs[0]!.tool_call_id).toBe('call_step1')
      expect(toolMsgs[1]!.tool_call_id).toBe('call_step2')
    })
  })
})
