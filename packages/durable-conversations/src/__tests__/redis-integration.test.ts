import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { run } from 'effection'
import { createClient, type RedisClientType } from 'redis'
import { createServer, type Server } from 'node:http'

import { createRedisTokenBufferStore } from '@sweatpants/durable-streams'
import { createConversationStore } from '../conversation-store.ts'
import { createDurableConversationHandler } from '../handler.ts'
import type { ConversationEvent } from '../event-types.ts'
import { isOllamaAvailable } from '../llm-client.ts'

function redisUrl(): string {
  return process.env['REDIS_URL'] ?? 'redis://localhost:6379'
}

async function isRedisAvailable(): Promise<boolean> {
  try {
    const client = createClient({ url: redisUrl() })
    await client.connect()
    await client.ping()
    await client.disconnect()
    return true
  } catch {
    return false
  }
}

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

interface TestServerHandle {
  url: string
  close: () => Promise<void>
}

async function createTestServer(handler: (req: Request) => Promise<Response>): Promise<TestServerHandle> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost`)
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers as Record<string, string>,
      })
      const response = await handler(request)
      res.statusCode = response.status
      response.headers.forEach((value, key) => res.setHeader(key, value))
      if (response.body) {
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      }
      res.end()
    } catch (error) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }))
    }
  })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address() as { port: number }

  return {
    url: `http://localhost:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

describe('Redis-backed durable conversations', () => {
  let client: RedisClientType
  let redisAvailable = false
  let ollamaAvailable = false

  beforeAll(async () => {
    redisAvailable = await isRedisAvailable()
    ollamaAvailable = await isOllamaAvailable({ requireToolCalling: true })
    if (!redisAvailable) {
      return
    }
    client = createClient({ url: redisUrl() })
    await client.connect()
    await client.flushDb()
  })

  afterEach(async () => {
    if (redisAvailable) {
      await client.flushDb()
    }
  })

  it('persists conversation events to Redis and survives handler restart', async () => {
    if (!redisAvailable || !ollamaAvailable) {
      return
    }

    const bufferStore = createRedisTokenBufferStore<ConversationEvent>(client)
    const store = createConversationStore({
      createBuffer: (id) => {
        throw new Error('Redis store requires async initialization')
      },
    })

    const conversationId = `redis-test-${Date.now()}`

    const handler = createDurableConversationHandler({ store })
    const server = await createTestServer(handler)

    try {
      const createResponse = await fetch(`${server.url}/conversations/${conversationId}`, { method: 'PUT' })
      expect(createResponse.status).toBe(201)

      const postResponse = await fetch(`${server.url}/conversations/${conversationId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Use the echo tool with message "redis persist".' }],
        }),
      })

      expect(postResponse.status).toBe(200)
      const firstFrames = parseNDJSON(await postResponse.text())
      const elicitEvent = firstFrames.find((frame) => frame.event.type === 'elicit_request')
      expect(elicitEvent).toBeDefined()

      const secondResponse = await fetch(`${server.url}/conversations/${conversationId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const toolResultEvent = secondFrames.find((frame) => frame.event.type === 'tool_result')
      expect(toolResultEvent).toBeDefined()
      expect(toolResultEvent?.event.content).toContain('redis persist')

      const assistantMessageEvent = secondFrames.find(
        (frame) => frame.event.type === 'assistant_message_complete',
      )
      expect(assistantMessageEvent).toBeDefined()

      const getResponse = await fetch(`${server.url}/conversations/${conversationId}?offset=0`, { method: 'GET' })
      expect(getResponse.status).toBe(200)
      const allFrames = parseNDJSON(await getResponse.text())
      const allEventTypes = allFrames.map((frame) => frame.event.type)
      expect(allEventTypes).toContain('user_message')
      expect(allEventTypes).toContain('tool_call')
      expect(allEventTypes).toContain('tool_result')
      expect(allEventTypes).toContain('elicit_request')
      expect(allEventTypes).toContain('elicit_response')
      expect(allEventTypes).toContain('assistant_message_complete')
    } finally {
      await server.close()
    }
  }, 60_000)
}, 90_000)
