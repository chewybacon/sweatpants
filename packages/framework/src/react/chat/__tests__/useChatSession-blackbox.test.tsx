import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { Readable } from 'node:stream'
import { type ReactNode } from 'react'

import { ChatProvider } from '../ChatProvider'
import { useChatSession } from '../useChatSession'

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

describe('useChatSession (black-box)', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('chains request 1 then request 2 with plugin elicit result', async () => {
    const fetchBodies: unknown[] = []

    const response1 = ndjsonResponse([
      {
        type: 'session_info',
        capabilities: { thinking: false, streaming: true, tools: ['book_flight'] },
        persona: null,
      },
      {
        type: 'plugin_elicit_request',
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
        type: 'plugin_elicit_request',
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
      // Capture posted JSON body for black-box verification
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

    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChatProvider baseUrl="http://localhost/chat">{children}</ChatProvider>
    )

    const { result, unmount } = renderHook(() => useChatSession({ transforms: [] }), { wrapper })

    // Request 1
    act(() => {
      result.current.send('Book a flight')
    })

    await waitFor(() => {
      expect(result.current.pluginElicitations.length).toBeGreaterThan(0)
      expect(result.current.pluginElicitations[0]!.elicitations[0]!.key).toBe('pickFlight')
    })

    const firstTracking = result.current.pluginElicitations[0]!
    const firstElicit = firstTracking.elicitations.find((e) => e.key === 'pickFlight')
    expect(firstElicit).toBeTruthy()

    // Respond: this should enqueue pluginElicitResponses and auto-continue (request 2)
    act(() => {
      result.current.respondToPluginElicit(
        { sessionId: firstElicit!.sessionId, callId: firstElicit!.callId, elicitId: firstElicit!.elicitId },
        { action: 'accept', content: { flightId: 'FL001' } }
      )
    })

    // Wait for request 2 to update state
    await waitFor(() => {
      const tracking = result.current.pluginElicitations.find((t) => t.callId === 'call-1')
      const seat = tracking?.elicitations.find((e) => e.key === 'pickSeat')
      expect(seat).toBeTruthy()
    })

    // Black-box assertion: request 2 body included the elicit response
    expect(fetchBodies.length).toBeGreaterThanOrEqual(2)
    const secondBody = fetchBodies[1] as any
    expect(secondBody.pluginElicitResponses).toBeTruthy()
    expect(secondBody.pluginElicitResponses[0]).toMatchObject({
      sessionId: 'sess-1',
      callId: 'call-1',
      elicitId: 'elicit-1',
      result: { action: 'accept', content: { flightId: 'FL001' } },
    })

    unmount()
  })
})
