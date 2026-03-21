import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { ConversationEvent } from '../event-types.ts'
import { reduceConversationEvents } from '../client-reducer.ts'
import { createDurableConversationHandler } from '../handler.ts'
import { isOllamaAvailable } from '../llm-client.ts'
import { createHttpTestServer, type TestServerHandle } from './test-server.ts'

interface EventFrame {
  offset: string
  event: ConversationEvent
}

async function readSomeFrames(
  response: Response,
  limit: number,
  options: { cancel?: boolean } = {},
): Promise<{ frames: EventFrame[]; lastOffset: string | null }> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const frames: EventFrame[] = []
  let pending = ''

  try {
    while (frames.length < limit) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) {
          continue
        }
        frames.push(JSON.parse(line) as EventFrame)
        if (frames.length >= limit) {
          break
        }
      }
    }
  } finally {
    if (options.cancel !== false) {
      await reader.cancel()
    }
    reader.releaseLock()
  }

  return {
    frames,
    lastOffset: frames.length > 0 ? frames[frames.length - 1]!.offset : null,
  }
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

    const userEvent = firstFrames.find((frame) => frame.event.type === 'user_message')
    expect(userEvent?.event.type).toBe('user_message')

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

    const assistantMessageEvent = secondFrames.find((frame) => frame.event.type === 'assistant_message_complete')
    expect(assistantMessageEvent).toBeDefined()

    const getResponse = await fetch(`${baseUrl}?offset=0`, { method: 'GET' })
    expect(getResponse.status).toBe(200)
    const allFrames = parseNDJSON(await getResponse.text())

    const allEventTypes = allFrames.map((frame) => frame.event.type)
    expect(allEventTypes).toContain('user_message')
    expect(allEventTypes).toContain('assistant_message_complete')
    expect(allEventTypes).toContain('tool_call')
    expect(allEventTypes).toContain('tool_result')
    expect(allEventTypes).toContain('elicit_request')
    expect(allEventTypes).toContain('elicit_response')

    const reduced = reduceConversationEvents(allFrames.map((frame) => frame.event))
    expect(reduced.orderedAssistantMessageIds.length).toBeGreaterThan(0)
    const completedAssistant = reduced.orderedAssistantMessageIds
      .map((id) => reduced.assistantMessages[id])
      .find((message) => message?.completed)
    expect(completedAssistant?.completed).toBe(true)
    expect(completedAssistant?.text.length).toBeGreaterThan(0)
  }, 60_000)

  it('continues producer work even when streaming client disconnects', async () => {
    if (!ollamaAvailable) {
      return
    }

    const handler = createDurableConversationHandler()
    server = await createHttpTestServer(handler)

    const conversationId = crypto.randomUUID()
    const baseUrl = `${server.url}/conversations/${conversationId}`

    const createResponse = await fetch(baseUrl, { method: 'PUT' })
    expect(createResponse.status).toBe(201)

    const controller = new AbortController()
    const postResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: 'Use the echo tool with message "continue without reader".',
          },
          {
            role: 'user',
            content: 'Second message should persist even if the reader disconnects.',
          },
        ],
      }),
    })

    expect(postResponse.status).toBe(200)

    // Simulate client disconnect right after response begins.
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 1200))

    // Reconnect and verify events were persisted despite disconnect.
    const replayResponse = await fetch(`${baseUrl}?offset=0`, { method: 'GET' })
    expect(replayResponse.status).toBe(200)
    const frames = parseNDJSON(await replayResponse.text())

    const userMessages = frames.filter((frame) => frame.event.type === 'user_message')

    expect(userMessages.length).toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('reconnects during assistant generation using offsets', async () => {
    if (!ollamaAvailable) {
      return
    }

    const handler = createDurableConversationHandler()
    server = await createHttpTestServer(handler)

    const conversationId = crypto.randomUUID()
    const baseUrl = `${server.url}/conversations/${conversationId}`

    const createResponse = await fetch(baseUrl, { method: 'PUT' })
    expect(createResponse.status).toBe(201)

    const firstResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: 'Use the echo tool with message "reconnect me".',
          },
        ],
      }),
    })

    const firstFrames = parseNDJSON(await firstResponse.text())
    const elicitEvent = firstFrames.find((frame) => frame.event.type === 'elicit_request')
    expect(elicitEvent).toBeDefined()

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

    const initialRead = await readSomeFrames(secondResponse, 3)
    expect(initialRead.frames.length).toBeGreaterThan(0)
    expect(initialRead.lastOffset).toBeTruthy()

    await new Promise((resolve) => setTimeout(resolve, 1000))

    const replayResponse = await fetch(`${baseUrl}?offset=${encodeURIComponent(initialRead.lastOffset!)}`, {
      method: 'GET',
    })

    expect(replayResponse.status).toBe(200)
    const replayFrames = parseNDJSON(await replayResponse.text())

    expect(replayFrames.length).toBeGreaterThan(0)
    expect(replayFrames.some((frame) => frame.event.type === 'assistant_message_delta' || frame.event.type === 'assistant_message_complete')).toBe(true)

    const seenOffsets = [...initialRead.frames, ...replayFrames].map((frame) => frame.offset)
    const sortedOffsets = [...seenOffsets].sort()
    expect(seenOffsets).toEqual(sortedOffsets)
  }, 60_000)

  it('tails GET stream from an offset while new events arrive', async () => {
    if (!ollamaAvailable) {
      return
    }

    const handler = createDurableConversationHandler()
    server = await createHttpTestServer(handler)

    const conversationId = crypto.randomUUID()
    const baseUrl = `${server.url}/conversations/${conversationId}`

    const createResponse = await fetch(baseUrl, { method: 'PUT' })
    expect(createResponse.status).toBe(201)

    const controller = new AbortController()
    const liveResponsePromise = fetch(`${baseUrl}?offset=0&live=stream`, {
      method: 'GET',
      signal: controller.signal,
    })

    try {
      await new Promise((resolve) => setTimeout(resolve, 50))

      const appendResponse = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: 'Use the echo tool with message "tail me".',
            },
          ],
        }),
      })
      expect(appendResponse.status).toBe(200)

      const liveResponse = await liveResponsePromise
      expect(liveResponse.status).toBe(200)

      const liveFrames = await readSomeFrames(liveResponse, 1)
      expect(liveFrames.frames.length).toBeGreaterThan(0)
      expect(liveFrames.frames.some((frame) => frame.event.type === 'user_message')).toBe(true)
    } finally {
      controller.abort()
    }
  }, 60_000)
})
