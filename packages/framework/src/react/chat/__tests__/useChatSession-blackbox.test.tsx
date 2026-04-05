import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { Readable } from 'node:stream'
import { type ReactNode } from 'react'
import { z } from 'zod'

import { ChatProvider } from '../ChatProvider.tsx'
import { useChatSession } from '../useChatSession.ts'
import type { PluginClientRegistrationInput } from '../../../lib/chat/mcp-tools/plugin.ts'
import { createIsomorphicTool } from '../../../lib/chat/isomorphic-tools/builder.ts'

function ndjsonResponse(events: unknown[]): Response {
  const lines = events.map((event, i) => JSON.stringify({ lsn: i + 1, event }) + '\n')
  const nodeStream = Readable.from(lines.map((l) => Buffer.from(l)))
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'X-Session-Id': 'test-session',
    },
  })
}

// Simple test component that renders and waits for response
function TestFlightPicker(props: { flights: unknown[]; message: string; onRespond: (value: unknown) => void }) {
  return null // In tests we call onRespond directly
}

function TestSeatPicker(props: { seatMap: unknown; message: string; onRespond: (value: unknown) => void }) {
  return null
}

function TestCardPicker(props: {
  cards: string[]
  prompt: string
  onRespond: (value: unknown) => void
  disabled?: boolean
  response?: unknown
}) {
  return null
}

// Create a mock plugin for testing
function createMockBookFlightPlugin(): PluginClientRegistrationInput {
  return {
    toolName: 'book_flight',
    handlers: {
      pickFlight: function* (_req, ctx) {
        // Render a component and wait for user response
        const result = yield* ctx.render(TestFlightPicker, {
          flights: [],
          message: 'Pick a flight',
        })
        return { action: 'accept', content: result }
      },
      pickSeat: function* (_req, ctx) {
        const result = yield* ctx.render(TestSeatPicker, {
          seatMap: {},
          message: 'Pick a seat',
        })
        return { action: 'accept', content: result }
      },
    },
    schemas: {
      pickFlight: z.object({ flightId: z.string() }),
      pickSeat: z.object({ row: z.number(), seat: z.string() }),
    },
  }
}

describe('useChatSession (black-box)', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('chains request 1 then request 2 with plugin elicit result (unified pattern)', async () => {
    const fetchBodies: unknown[] = []

    const response1 = ndjsonResponse([
      {
        type: 'session_info',
        capabilities: { thinking: false, streaming: true, tools: ['book_flight'] },
        persona: null,
      },
      // Tool call must come first to create the tool-call part in streaming state
      {
        type: 'tool_calls',
        calls: [{ id: 'call-1', name: 'book_flight', arguments: { from: 'NYC', to: 'LAX' } }],
      },
      // Then the elicit request arrives (tool is running and needs user input)
      {
        type: 'elicit_request',
        sessionId: 'sess-1',
        callId: 'call-1',
        toolName: 'book_flight',
        elicitId: 'elicit-1',
        key: 'pickFlight',
        message: 'Pick a flight',
        schema: { type: 'object', properties: { flightId: { type: 'string' } } },
      },
    ])

    const response2 = ndjsonResponse([
      {
        type: 'session_info',
        capabilities: { thinking: false, streaming: true, tools: ['book_flight'] },
        persona: null,
      },
      {
        type: 'elicit_request',
        sessionId: 'sess-1',
        callId: 'call-1',
        toolName: 'book_flight',
        elicitId: 'elicit-2',
        key: 'pickSeat',
        message: 'Pick a seat',
        schema: { type: 'object', properties: { row: { type: 'number' }, seat: { type: 'string' } } },
      },
    ])

    const responses = [response1, response2]

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        try {
          fetchBodies.push(JSON.parse(String(init.body)))
        } catch {
          fetchBodies.push(init.body)
        }
      }

      const next = responses.shift()
      if (!next) {
        throw new Error('Unexpected extra fetch call')
      }
      return next
    }

    const mockPlugin = createMockBookFlightPlugin()

    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChatProvider baseUrl="http://localhost/chat">{children}</ChatProvider>
    )

    const { result, unmount } = renderHook(
      () => useChatSession({ transforms: [], plugins: [mockPlugin] }),
      { wrapper }
    )

    // Request 1: Send message
    act(() => {
      result.current.send('Book a flight')
    })

    // Wait for toolEmissions to appear (from plugin handler's ctx.render())
    await waitFor(() => {
      expect(result.current.toolEmissions.length).toBeGreaterThan(0)
    }, { timeout: 5000 })

    // Find the pending emission
    const tracking = result.current.toolEmissions[0]!
    expect(tracking.callId).toBe('call-1')

    const pendingEmission = tracking.emissions.find(e => e.status === 'pending')
    expect(pendingEmission).toBeTruthy()

    // Respond to the emission (simulating user picking a flight)
    act(() => {
      result.current.respondToEmission(
        tracking.callId,
        pendingEmission!.id,
        { flightId: 'FL001' }
      )
    })

    // Wait for request 2 - the pickSeat elicitation
    await waitFor(() => {
      // Should have a new emission for pickSeat
      const currentTracking = result.current.toolEmissions.find(t => t.callId === 'call-1')
      const seatEmission = currentTracking?.emissions.find(
        e => e.status === 'pending' && e.id !== pendingEmission!.id
      )
      expect(seatEmission).toBeTruthy()
    })

    // Black-box assertion: request 2 body included the elicit response
    expect(fetchBodies.length).toBeGreaterThanOrEqual(2)
    const secondBody = fetchBodies[1] as Record<string, unknown>
    expect(secondBody['elicitResponses']).toBeTruthy()
    expect((secondBody['elicitResponses'] as unknown[])[0]).toMatchObject({
      sessionId: 'sess-1',
      callId: 'call-1',
      elicitId: 'elicit-1',
      result: { action: 'accept', content: { flightId: 'FL001' } },
    })

    unmount()
  })

  it('hydrates durable conversation history when conversationId is provided', async () => {
    const fetchBodies: unknown[] = []

    const historyResponse = ndjsonResponse([
      {
        type: 'session_info',
        capabilities: { thinking: false, streaming: true, tools: [] },
        persona: null,
      },
      { type: 'text', content: 'Hello from history' },
      { type: 'complete', text: 'Hello from history' },
    ])

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('conversationId=thread-1') && (!init?.method || init.method === 'GET')) {
        return historyResponse.clone()
      }

      if (init?.body) {
        try {
          fetchBodies.push(JSON.parse(String(init.body)))
        } catch {
          fetchBodies.push(init.body)
        }
      }

      return ndjsonResponse([
        {
          type: 'session_info',
          capabilities: { thinking: false, streaming: true, tools: [] },
          persona: null,
        },
        { type: 'text', content: 'Fresh response' },
        { type: 'complete', text: 'Fresh response' },
      ])
    }

    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChatProvider baseUrl="http://localhost/chat">{children}</ChatProvider>
    )

    const { result } = renderHook(
      () => useChatSession({ transforms: [], conversationId: 'thread-1' }),
      { wrapper },
    )

    await waitFor(() => {
      expect(result.current.state.messages).toHaveLength(1)
    })

    expect(result.current.state.messages[0]?.content).toBe('Hello from history')

    act(() => {
      result.current.send('Continue the thread')
    })

    await waitFor(() => {
      expect(result.current.state.messages.some((message) => message.content === 'Fresh response')).toBe(true)
    })

    expect(fetchBodies).toHaveLength(1)
    const requestBody = fetchBodies[0] as Record<string, unknown>
    expect(requestBody['conversationId']).toBe('thread-1')
    expect(requestBody['messages']).toMatchObject([
      { role: 'assistant', content: 'Hello from history' },
      { role: 'user', content: 'Continue the thread' },
    ])
  })

  it('rehydrates isomorphic tool emissions from durable history when tools are provided', async () => {
    const pickCardTool = createIsomorphicTool('pick_card')
      .description('Pick a card')
      .parameters(z.object({ count: z.number() }))
      .context('browser')
      .handoff({
        *before() {
          return { cards: ['A', 'K'], prompt: 'Pick a card' }
        },
        *client(_handoff, _ctx: any) {
          return { picked: 'A' }
        },
        *after(_handoff, client) {
          return { picked: client.picked }
        },
      })

    pickCardTool.replayTrace = function* (trace) {
      return {
        ...trace,
        emissions: trace.emissions.map((entry) => ({
          ...entry,
          _component: TestCardPicker,
        })),
      }
    }

    const historyResponse = ndjsonResponse([
      {
        type: 'session_info',
        capabilities: { thinking: false, streaming: true, tools: ['pick_card'] },
        persona: null,
      },
      {
        type: 'tool_calls',
        calls: [{ id: 'call-1', name: 'pick_card', arguments: { count: 2 } }],
      },
      {
        type: 'tool_result',
        id: 'call-1',
        name: 'pick_card',
        content: 'The user selected the Ace of Spades.',
        trace: {
          emissions: [
            {
              order: 0,
              componentKey: 'CardPicker',
              props: {
                cards: ['A', 'K'],
                prompt: 'Pick a card',
              },
              response: { picked: 'A' },
              timestamp: 100,
            },
          ],
          startedAt: 50,
          completedAt: 200,
        },
      },
      { type: 'complete', text: 'Done' },
    ])

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('conversationId=thread-tools') && (!init?.method || init.method === 'GET')) {
        return historyResponse.clone()
      }

      return ndjsonResponse([
        {
          type: 'session_info',
          capabilities: { thinking: false, streaming: true, tools: [] },
          persona: null,
        },
        { type: 'complete', text: 'noop' },
      ])
    }

    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChatProvider baseUrl="http://localhost/chat">{children}</ChatProvider>
    )

    const { result } = renderHook(
      () => useChatSession({ transforms: [], conversationId: 'thread-tools', tools: [pickCardTool] }),
      { wrapper },
    )

    await waitFor(() => {
      expect(result.current.toolEmissions.length).toBe(1)
    })

    const tracking = result.current.toolEmissions[0]
    expect(tracking?.callId).toBe('call-1')
    expect(tracking?.status).toBe('complete')
    expect(tracking?.emissions[0]?.payload._component).toBe(TestCardPicker)
    expect(tracking?.emissions[0]?.response).toEqual({ picked: 'A' })
    expect(tracking?.emissions[0]?.status).toBe('complete')
  })
})
