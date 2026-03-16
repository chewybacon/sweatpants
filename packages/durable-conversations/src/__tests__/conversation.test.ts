import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { ConversationEvent } from '../event-types.ts'
import { createDurableConversationHandler } from '../handler.ts'
import { isOllamaAvailable } from '../llm-client.ts'
import { createHttpTestServer, type TestServerHandle } from './test-server.ts'

interface EventFrame {
  offset: string
  event: ConversationEvent
}

function parseNDJSON(text: string): EventFrame[] {
  const trimmed = text.trim()
  if (!trimmed) {
    return []
  }
  return trimmed.split('\n').map((line) => JSON.parse(line) as EventFrame)
}

describe('durable conversations over HTTP', () => {
  let server: TestServerHandle | null = null
  let ollamaAvailable = false

  beforeAll(async () => {
    ollamaAvailable = await isOllamaAvailable()
  })

  afterEach(async () => {
    if (server) {
      await server.close()
      server = null
    }
  })

  it('supports multi-turn tool + elicit durable flow', async () => {
    if (!ollamaAvailable) {
      return
    }

    const handler = createDurableConversationHandler()
    server = await createHttpTestServer(handler)

    const conversationId = crypto.randomUUID()
    const baseUrl = `${server.url}/conversations/${conversationId}`

    const putResponse = await fetch(baseUrl, {
      method: 'PUT',
    })

    expect(putResponse.status).toBe(201)
    expect(putResponse.headers.get('Stream-Next-Offset')).toBe('0000000000000000')

    const firstResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: 'Use the echo tool with message "hello durable stream".',
          },
        ],
      }),
    })

    expect(firstResponse.status).toBe(200)
    const firstFrames = parseNDJSON(await firstResponse.text())

    const userEvent = firstFrames.find((frame) => frame.event.type === 'message' && frame.event.from === 'user')
    expect(userEvent).toBeDefined()

    const toolCallEvent = firstFrames.find((frame) => frame.event.type === 'tool_call')
    expect(toolCallEvent).toBeDefined()
    expect(toolCallEvent?.event.toolName).toBe('echo')

    const elicitEvent = firstFrames.find((frame) => frame.event.type === 'elicit_request')
    expect(elicitEvent).toBeDefined()
    expect(elicitEvent?.event.elicitId).toBeTruthy()

    const secondResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [],
        elicitResponses: [
          {
            callId: elicitEvent?.event.callId,
            elicitId: elicitEvent?.event.elicitId,
            response: 'yes',
          },
        ],
      }),
    })

    expect(secondResponse.status).toBe(200)
    const secondFrames = parseNDJSON(await secondResponse.text())

    const elicitResponseEvent = secondFrames.find((frame) => frame.event.type === 'elicit_response')
    expect(elicitResponseEvent).toBeDefined()

    const toolResultEvent = secondFrames.find((frame) => frame.event.type === 'tool_result')
    expect(toolResultEvent).toBeDefined()
    expect(toolResultEvent?.event.content).toContain('hello durable stream')

    const assistantMessageEvent = secondFrames.find(
      (frame) => frame.event.type === 'message' && frame.event.from === 'assistant',
    )
    expect(assistantMessageEvent).toBeDefined()

    const getResponse = await fetch(`${baseUrl}?offset=0`, { method: 'GET' })
    expect(getResponse.status).toBe(200)
    const allFrames = parseNDJSON(await getResponse.text())

    const allEventTypes = allFrames.map((frame) => frame.event.type)
    expect(allEventTypes).toContain('message')
    expect(allEventTypes).toContain('tool_call')
    expect(allEventTypes).toContain('tool_result')
    expect(allEventTypes).toContain('elicit_request')
    expect(allEventTypes).toContain('elicit_response')
  }, 60_000)
})
