import { run } from 'effection'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createPiAiRuntime } from '../runtime/pi-ai.ts'
import type { AssistantMessage, Context, Model } from '../runtime/types.ts'

const piAiMocks = vi.hoisted(() => ({
  stream: vi.fn(),
  generateImages: vi.fn(),
}))

vi.mock('@earendil-works/pi-ai', () => ({
  stream: piAiMocks.stream,
  generateImages: piAiMocks.generateImages,
}))

const testModel: Model = {
  id: 'zai.glm-5',
  name: 'GLM 5',
  api: 'bedrock-converse-stream',
  provider: 'amazon-bedrock',
  reasoning: false,
  input: ['text'],
  contextWindow: 128000,
  maxTokens: 32000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

const finalPiMessage = {
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text: 'done' }],
  api: 'bedrock-converse-stream',
  provider: 'amazon-bedrock',
  model: 'zai.glm-5',
  stopReason: 'stop' as const,
  timestamp: 1,
}

function mockPiStream(events: unknown[], finalMessage: unknown = finalPiMessage): void {
  piAiMocks.stream.mockReturnValue({
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next(): Promise<IteratorResult<unknown>> {
          if (index < events.length) {
            return { done: false, value: events[index++] }
          }
          return { done: true, value: undefined }
        },
        async return(): Promise<IteratorResult<unknown>> {
          return { done: true, value: undefined }
        },
      }
    },
    result: vi.fn(async () => finalMessage),
  })
}

beforeEach(() => {
  piAiMocks.stream.mockReset()
  piAiMocks.generateImages.mockReset()
  mockPiStream([])
})

describe('pi-ai provider boundary normalization', () => {
  it('converts Zod tool and response schemas to clone-safe JSON Schema before calling pi-ai', async () => {
    const runtime = createPiAiRuntime()
    const context: Context = {
      messages: [{ role: 'user', content: 'Book a flight from NYC to LA' }],
      tools: [
        {
          name: 'book_flight',
          description: 'Book a flight',
          parameters: z.object({
            origin: z.string(),
            destination: z.string(),
          }) as unknown as Record<string, unknown>,
        },
      ],
    }

    await run(function* () {
      const subscription = yield* runtime.stream(testModel, context, {
        responseFormat: {
          type: 'json_schema',
          name: 'booking_result',
          schema: z.object({ confirmation: z.string() }) as unknown as Record<string, unknown>,
        },
      })
      const next = yield* subscription.next()
      expect(next.done).toBe(true)
    })

    expect(piAiMocks.stream).toHaveBeenCalledTimes(1)
    const [, piContext, piOptions] = piAiMocks.stream.mock.calls[0]!
    const toolSchema = piContext.tools[0].parameters
    const responseSchema = piOptions.responseFormat.schema

    expect(toolSchema).toMatchObject({
      type: 'object',
      properties: {
        origin: { type: 'string' },
        destination: { type: 'string' },
      },
      required: ['origin', 'destination'],
    })
    expect(responseSchema).toMatchObject({
      type: 'object',
      properties: { confirmation: { type: 'string' } },
      required: ['confirmation'],
    })
    expect((toolSchema as { safeParse?: unknown }).safeParse).toBeUndefined()
    expect((responseSchema as { safeParse?: unknown }).safeParse).toBeUndefined()
    expect(() => structuredClone({ tools: piContext.tools, responseFormat: piOptions.responseFormat })).not.toThrow()
  })

  it('drops empty assistant and pending tool-result replay messages before calling pi-ai', async () => {
    const runtime = createPiAiRuntime()

    await run(function* () {
      const subscription = yield* runtime.stream(testModel, {
        messages: [
          { role: 'user', content: 'Book a flight' },
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'call-1',
                name: 'book_flight',
                arguments: { from: 'LAX', destination: 'NYC' },
              },
            ],
          },
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'book_flight',
            content: [{ type: 'text', text: '' }],
            isError: false,
          },
          { role: 'assistant', content: [] },
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'book_flight',
            content: [{ type: 'text', text: '{"success":true,"ticketNumber":"TKT-123"}' }],
            isError: false,
          },
        ],
      })
      const next = yield* subscription.next()
      expect(next.done).toBe(true)
    })

    const [, piContext] = piAiMocks.stream.mock.calls[0]!
    expect(piContext.messages.map((message: { role: string }) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
    ])
    expect(piContext.messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: '{"success":true,"ticketNumber":"TKT-123"}' }],
    })
  })

  it('omits historical completed tool protocol once an assistant summary exists', async () => {
    const runtime = createPiAiRuntime()

    await run(function* () {
      const subscription = yield* runtime.stream(testModel, {
        messages: [
          { role: 'user', content: 'Book an outbound flight' },
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'call-1',
                name: 'book_flight',
                arguments: { from: 'LAX', destination: 'NYC' },
              },
            ],
          },
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'book_flight',
            content: [{ type: 'text', text: '{"success":true,"ticketNumber":"TKT-123"}' }],
            isError: false,
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Your outbound flight is confirmed. Ticket TKT-123.' }],
          },
          { role: 'user', content: 'Now book the return flight' },
        ],
      })
      const next = yield* subscription.next()
      expect(next.done).toBe(true)
    })

    const [, piContext] = piAiMocks.stream.mock.calls[0]!
    expect(piContext.messages).toMatchObject([
      { role: 'user' },
      { role: 'assistant', content: [{ type: 'text', text: 'Your outbound flight is confirmed. Ticket TKT-123.' }] },
      { role: 'user' },
    ])
    expect(JSON.stringify(piContext.messages)).not.toContain('toolResult')
    expect(JSON.stringify(piContext.messages)).not.toContain('toolCall')
  })

  it('omits orphan historical tool results before calling pi-ai', async () => {
    const runtime = createPiAiRuntime()

    await run(function* () {
      const subscription = yield* runtime.stream(testModel, {
        messages: [
          { role: 'user', content: 'Book an outbound flight' },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Your outbound flight is confirmed. Ticket TKT-123.' }],
          },
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'book_flight',
            content: [{ type: 'text', text: '{"success":true,"ticketNumber":"TKT-123"}' }],
            isError: false,
          },
          { role: 'user', content: 'Now book the return flight' },
        ],
      })
      const next = yield* subscription.next()
      expect(next.done).toBe(true)
    })

    const [, piContext] = piAiMocks.stream.mock.calls[0]!
    expect(piContext.messages.map((message: { role: string }) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
    expect(JSON.stringify(piContext.messages)).not.toContain('toolResult')
  })

  it('normalizes provider tool-call arguments that arrive as JSON strings', async () => {
    const runtime = createPiAiRuntime()
    const partial = {
      ...finalPiMessage,
      content: [
        {
          type: 'toolCall' as const,
          id: 'call-1',
          name: 'book_flight',
          arguments: '{"origin":"NYC","destination":"LAX"}',
        },
      ],
    }
    mockPiStream([
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: {
          id: 'call-1',
          name: 'book_flight',
          arguments: '{"origin":"NYC","destination":"LAX"}',
        },
        partial,
      },
    ])

    let assistant: AssistantMessage | undefined
    await run(function* () {
      const subscription = yield* runtime.stream(testModel, {
        messages: [{ role: 'user', content: 'Book a flight' }],
      })
      const next = yield* subscription.next()
      expect(next.done).toBe(false)
      if (!next.done) {
        expect(next.value).toMatchObject({
          type: 'toolcall_end',
          toolCall: {
            id: 'call-1',
            name: 'book_flight',
            arguments: { origin: 'NYC', destination: 'LAX' },
          },
          partial: {
            content: [
              {
                type: 'toolCall',
                arguments: { origin: 'NYC', destination: 'LAX' },
              },
            ],
          },
        })
      }
      const done = yield* subscription.next()
      expect(done.done).toBe(true)
      if (done.done) assistant = done.value
    })

    expect(assistant).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'done' }] })
  })
})
