/**
 * OpenAI Provider Conformance Tests
 * 
 * These tests verify the OpenAI provider correctly implements the ChatProvider
 * interface, particularly for multi-turn tool calling scenarios.
 * 
 * Tests use mock SSE streams that mimic the exact format of OpenAI's Responses API.
 */
import { describe, it, expect } from '../../isomorphic-tools/__tests__/vitest-effection'
import { vi } from 'vitest'
import { openaiProvider } from '../openai'
import type { Message } from '../../types'
import type { Operation } from 'effection'

// =============================================================================
// MOCK SSE STREAM UTILITIES
// =============================================================================

/**
 * Create a mock SSE stream from an array of events.
 * Each event is a JSON object that will be serialized and sent as SSE data.
 */
function createMockSSEStream(events: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0

  return new ReadableStream({
    pull(controller) {
      if (index < events.length) {
        const event = events[index++]
        const sseData = `data: ${JSON.stringify(event)}\n\n`
        controller.enqueue(encoder.encode(sseData))
      } else {
        // Send [DONE] to signal end of stream (OpenAI convention)
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    },
  })
}

/**
 * Create a mock fetch that returns a mock SSE response.
 */
function createMockFetch(events: object[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    body: createMockSSEStream(events),
  })
}

// =============================================================================
// OPENAI SSE EVENT BUILDERS
// =============================================================================

/**
 * Build OpenAI SSE events for a text response.
 */
function buildTextResponseEvents(text: string): object[] {
  const events: object[] = []
  
  // Stream text in chunks
  const chunks = text.match(/.{1,10}/g) || [text]
  for (const chunk of chunks) {
    events.push({
      type: 'response.output_text.delta',
      delta: chunk,
    })
  }
  
  // Response completed with usage
  events.push({
    type: 'response.completed',
    response: {
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
      },
    },
  })
  
  return events
}

/**
 * Build OpenAI SSE events for a tool call.
 */
function buildToolCallEvents(
  callId: string,
  itemId: string,
  toolName: string,
  args: Record<string, unknown>
): object[] {
  const argsJson = JSON.stringify(args)
  
  return [
    // Item added - announces the function call
    {
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        id: itemId,
        call_id: callId,
        name: toolName,
      },
    },
    // Arguments streamed (could be multiple deltas, we'll do one for simplicity)
    {
      type: 'response.function_call_arguments.delta',
      item_id: itemId,
      delta: argsJson,
    },
    // Arguments complete
    {
      type: 'response.function_call_arguments.done',
      item_id: itemId,
      arguments: argsJson,
    },
    // Response completed
    {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 15,
          output_tokens: 25,
          total_tokens: 40,
        },
      },
    },
  ]
}

// buildTextAndToolCallEvents can be added later if needed for more complex tests

// =============================================================================
// HELPER TO CONSUME PROVIDER STREAM
// =============================================================================

function* consumeProviderStream(
  messages: Message[],
  mockFetch: ReturnType<typeof createMockFetch>
): Operation<{ events: Array<{ type: string; [key: string]: unknown }>; result: any }> {
  // Replace global fetch
  const originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch as unknown as typeof fetch

  try {
    const stream = openaiProvider.stream(messages, {
      apiKey: 'test-api-key',
      baseUri: 'https://api.openai.com/v1',
    })

    const subscription = yield* stream
    const events: Array<{ type: string; [key: string]: unknown }> = []

    while (true) {
      const next = yield* subscription.next()
      if (next.done) {
        return { events, result: next.value }
      }
      events.push(next.value as { type: string; [key: string]: unknown })
    }
  } finally {
    globalThis.fetch = originalFetch
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('OpenAI Provider Conformance', () => {
  describe('basic streaming', () => {
    it('should stream text responses', function* () {
      const mockFetch = createMockFetch(buildTextResponseEvents('Hello, world!'))

      const { events, result } = yield* consumeProviderStream(
        [{ role: 'user', content: 'Say hello' }],
        mockFetch
      )

      // Should have emitted text events
      const textEvents = events.filter((e) => e.type === 'text')
      expect(textEvents.length).toBeGreaterThan(0)

      // Result should have accumulated text
      expect(result.text).toBe('Hello, world!')

      // Should have usage
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      })
    })
  })

  describe('tool calling', () => {
    it('should emit tool_calls event when model requests a tool', function* () {
      const mockFetch = createMockFetch(
        buildToolCallEvents('call_123', 'item_abc', 'get_weather', { location: 'NYC' })
      )

      const { events, result } = yield* consumeProviderStream(
        [{ role: 'user', content: 'What is the weather in NYC?' }],
        mockFetch
      )

      // Should have emitted a tool_calls event
      const toolCallEvents = events.filter((e) => e.type === 'tool_calls')
      expect(toolCallEvents).toHaveLength(1)
      expect(toolCallEvents[0]).toEqual({
        type: 'tool_calls',
        toolCalls: [
          {
            id: 'call_123',
            function: {
              name: 'get_weather',
              arguments: { location: 'NYC' },
            },
          },
        ],
      })

      // Result should also have toolCalls
      expect(result.toolCalls).toBeDefined()
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls?.[0]?.id).toBe('call_123')
      expect(result.toolCalls?.[0]?.function.name).toBe('get_weather')
    })

    it('should handle tool results in subsequent messages', function* () {
      // First call: model requests a tool
      const firstMockFetch = createMockFetch(
        buildToolCallEvents('call_123', 'item_abc', 'get_weather', { location: 'NYC' })
      )

      const firstResult = yield* consumeProviderStream(
        [{ role: 'user', content: 'What is the weather in NYC?' }],
        firstMockFetch
      )

      expect(firstResult.result.toolCalls).toBeDefined()
      expect(firstResult.result.toolCalls!).toHaveLength(1)

      // Second call: send tool result, model responds with text
      const secondMockFetch = createMockFetch(
        buildTextResponseEvents('The weather in NYC is sunny and 72°F.')
      )

      const secondResult = yield* consumeProviderStream(
        [
          { role: 'user', content: 'What is the weather in NYC?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_123',
                type: 'function' as const,
                function: { name: 'get_weather', arguments: { location: 'NYC' } },
              },
            ],
          },
          {
            role: 'tool',
            content: JSON.stringify({ temperature: 72, condition: 'sunny' }),
            tool_call_id: 'call_123',
          },
        ],
        secondMockFetch
      )

      // Model should respond with text, no more tool calls
      expect(secondResult.result.text).toBe('The weather in NYC is sunny and 72°F.')
      expect(secondResult.result.toolCalls).toBeUndefined()
    })
  })

  describe('multi-turn tool calling', () => {
    /**
     * This is the critical test for the bug we're fixing.
     * 
     * Scenario:
     * 1. User asks to do something requiring multiple steps
     * 2. Model calls tool A
     * 3. Tool A result is sent back
     * 4. Model calls tool B (using info from tool A)
     * 5. Tool B result is sent back
     * 6. Model responds with final text
     * 
     * The bug: After step 3, when sending the conversation history to the model,
     * the tool_calls on the assistant message might be stripped, causing the
     * model to not understand the context.
     */
    it('should handle multi-turn tool calling with correct message history', function* () {
      // Turn 1: User asks, model calls first tool
      const turn1Fetch = createMockFetch(
        buildToolCallEvents('call_step1', 'item_1', 'step_one', { input: 'start' })
      )

      const turn1 = yield* consumeProviderStream(
        [{ role: 'user', content: 'Do the multi-step process' }],
        turn1Fetch
      )

      expect(turn1.result.toolCalls).toBeDefined()
      expect(turn1.result.toolCalls).toHaveLength(1)
      expect(turn1.result.toolCalls?.[0]?.function.name).toBe('step_one')

      // Turn 2: Send tool result, model calls second tool
      const turn2Fetch = createMockFetch(
        buildToolCallEvents('call_step2', 'item_2', 'step_two', { fromStep1: 'result1' })
      )

      const turn2Messages: Message[] = [
        { role: 'user', content: 'Do the multi-step process' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_step1',
              type: 'function',
              function: { name: 'step_one', arguments: { input: 'start' } },
            },
          ],
        },
        {
          role: 'tool',
          content: JSON.stringify({ result: 'result1' }),
          tool_call_id: 'call_step1',
        },
      ]

      const turn2 = yield* consumeProviderStream(turn2Messages, turn2Fetch)

      // This is the key assertion - model should be calling the second tool
      expect(turn2.result.toolCalls).toBeDefined()
      expect(turn2.result.toolCalls).toHaveLength(1)
      expect(turn2.result.toolCalls?.[0]?.function.name).toBe('step_two')

      // Turn 3: Send second tool result, model responds with final text
      const turn3Fetch = createMockFetch(
        buildTextResponseEvents('Process complete! Both steps finished successfully.')
      )

      const turn3Messages: Message[] = [
        { role: 'user', content: 'Do the multi-step process' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_step1',
              type: 'function',
              function: { name: 'step_one', arguments: { input: 'start' } },
            },
          ],
        },
        {
          role: 'tool',
          content: JSON.stringify({ result: 'result1' }),
          tool_call_id: 'call_step1',
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_step2',
              type: 'function',
              function: { name: 'step_two', arguments: { fromStep1: 'result1' } },
            },
          ],
        },
        {
          role: 'tool',
          content: JSON.stringify({ result: 'result2' }),
          tool_call_id: 'call_step2',
        },
      ]

      const turn3 = yield* consumeProviderStream(turn3Messages, turn3Fetch)

      expect(turn3.result.text).toBe('Process complete! Both steps finished successfully.')
      expect(turn3.result.toolCalls).toBeUndefined()
    })

    it('should correctly convert message history to OpenAI format', function* () {
      /**
       * This test verifies that when we send a conversation with tool_calls
       * and tool results, the OpenAI provider correctly converts them to
       * the Responses API format (function_call and function_call_output items).
       */
      const mockFetch = createMockFetch(buildTextResponseEvents('Done!'))

      const messages: Message[] = [
        { role: 'user', content: 'Start' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_abc',
              type: 'function',
              function: { name: 'my_tool', arguments: { x: 1 } },
            },
          ],
        },
        {
          role: 'tool',
          content: 'tool output',
          tool_call_id: 'call_abc',
        },
      ]

      yield* consumeProviderStream(messages, mockFetch)

      // Verify the request body sent to OpenAI
      expect(mockFetch).toHaveBeenCalled()
      const call = mockFetch.mock.calls[0] as [string, { body: string }]
      const requestBody = JSON.parse(call[1].body)

      // Should have converted to OpenAI Responses API format
      expect(requestBody.input).toEqual([
        { role: 'user', content: 'Start' },
        // Assistant message with empty content should NOT create a message item
        // Instead, tool_calls become function_call items
        {
          type: 'function_call',
          call_id: 'call_abc',
          name: 'my_tool',
          arguments: JSON.stringify({ x: 1 }),
        },
        // Tool result becomes function_call_output
        {
          type: 'function_call_output',
          call_id: 'call_abc',
          output: 'tool output',
        },
      ])
    })

    it('should verify request format matches OpenAI Responses API spec', function* () {
      /**
       * This test captures what we're actually sending to OpenAI and verifies it matches
       * the Responses API format. This helps debug issues where OpenAI isn't responding
       * as expected.
       */
      const mockFetch = createMockFetch(
        buildToolCallEvents('call_step2', 'item_2', 'step_two', { data: 'from_step1' })
      )

      // Simulate the conversation state after first tool call
      const messages: Message[] = [
        { role: 'user', content: 'Do multi-step process' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_step1',
              type: 'function',
              function: { name: 'step_one', arguments: { input: 'start' } },
            },
          ],
        },
        {
          role: 'tool',
          content: JSON.stringify({ result: 'step1_output' }),
          tool_call_id: 'call_step1',
        },
      ]

      const { result } = yield* consumeProviderStream(messages, mockFetch)

      // Verify the request format
      const call = mockFetch.mock.calls[0] as [string, { body: string }]
      const requestBody = JSON.parse(call[1].body)

      // Log for debugging
      console.log('Request sent to OpenAI:', JSON.stringify(requestBody.input, null, 2))

      // Verify the format matches OpenAI Responses API:
      // - User messages have role: 'user'
      // - Assistant tool calls become function_call items
      // - Tool results become function_call_output items
      expect(requestBody.input[0]).toEqual({ role: 'user', content: 'Do multi-step process' })
      expect(requestBody.input[1]).toMatchObject({
        type: 'function_call',
        call_id: 'call_step1',
        name: 'step_one',
      })
      expect(requestBody.input[2]).toMatchObject({
        type: 'function_call_output',
        call_id: 'call_step1',
      })

      // Provider should return the next tool call
      expect(result.toolCalls).toBeDefined()
      expect(result.toolCalls).toHaveLength(1)
    })

    it('should include tools in the request when provided', function* () {
      /**
       * Verify that isomorphicToolSchemas are included in the OpenAI request.
       */
      const mockFetch = createMockFetch(buildTextResponseEvents('Hello'))

      const originalFetch = globalThis.fetch
      globalThis.fetch = mockFetch as unknown as typeof fetch

      try {
        const stream = openaiProvider.stream(
          [{ role: 'user', content: 'Use the tool' }],
          {
            apiKey: 'test-api-key',
            baseUri: 'https://api.openai.com/v1',
            isomorphicToolSchemas: [
              {
                name: 'my_tool',
                description: 'A test tool',
                parameters: { type: 'object', properties: { x: { type: 'number' } } },
                isIsomorphic: true as const,
                authority: 'server' as const,
              },
            ],
          }
        )

        const subscription = yield* stream
        while (true) {
          const next = yield* subscription.next()
          if (next.done) break
        }
      } finally {
        globalThis.fetch = originalFetch
      }

      expect(mockFetch).toHaveBeenCalled()
      const call = mockFetch.mock.calls[0] as [string, { body: string }]
      const requestBody = JSON.parse(call[1].body)

      // Should have tools in the request
      expect(requestBody.tools).toBeDefined()
      expect(requestBody.tools).toHaveLength(1)
      expect(requestBody.tools[0].name).toBe('my_tool')
      expect(requestBody.tools[0].type).toBe('function')
    })

    it('should handle assistant message with both text and tool_calls', function* () {
      /**
       * Sometimes the model responds with text AND makes a tool call.
       * Both should be preserved in the message history.
       */
      const mockFetch = createMockFetch(buildTextResponseEvents('Understood!'))

      const messages: Message[] = [
        { role: 'user', content: 'Explain and then do it' },
        {
          role: 'assistant',
          content: 'Let me explain: I will call the tool now.',
          tool_calls: [
            {
              id: 'call_xyz',
              type: 'function',
              function: { name: 'do_thing', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'done',
          tool_call_id: 'call_xyz',
        },
      ]

      yield* consumeProviderStream(messages, mockFetch)

      const call2 = mockFetch.mock.calls[0] as [string, { body: string }]
      const requestBody = JSON.parse(call2[1].body)

      // Should have: user message, assistant text, function_call, function_call_output
      expect(requestBody.input).toEqual([
        { role: 'user', content: 'Explain and then do it' },
        { role: 'assistant', content: 'Let me explain: I will call the tool now.' },
        {
          type: 'function_call',
          call_id: 'call_xyz',
          name: 'do_thing',
          arguments: JSON.stringify({}),
        },
        {
          type: 'function_call_output',
          call_id: 'call_xyz',
          output: 'done',
        },
      ])
    })
  })
})
