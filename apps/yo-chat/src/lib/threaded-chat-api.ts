import { env } from '@/env'
import { getSharedRedisClient } from '@/lib/shared-redis'
import {
  createThreadBufferStore,
  createThreadedChatEngine,
  type ThreadMessageInput,
} from '@/lib/threaded-chat-store'
import { summarizeThreadFromEvents } from '@/lib/threaded-chat-types'

let threadedChatEnginePromise: Promise<ReturnType<typeof createThreadedChatEngine>> | null = null

async function getThreadedChatEngine() {
  if (threadedChatEnginePromise) {
    return threadedChatEnginePromise
  }

  threadedChatEnginePromise = (async () => {
    const client = await getSharedRedisClient()
    const bufferStore = createThreadBufferStore(client)

    return createThreadedChatEngine({
      bufferStore,
      providerName: env.CHAT_PROVIDER,
      systemPrompt:
        'You are a concise assistant in a durable threaded chat. Answer clearly and keep context across the whole thread.',
    })
  })()

  return threadedChatEnginePromise
}

export async function handleThreadedChatRequest(request: Request): Promise<Response> {
  const engine = await getThreadedChatEngine()
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method.toUpperCase()
  const threadMatch = path.match(/^\/api\/threaded-chat\/threads\/([^/]+)$/)

  if (path === '/api/threaded-chat/threads' && method === 'GET') {
    const threads = await Promise.all(
      engine.listThreadIds().map(async (threadId) => {
        const frames = await engine.readThread(threadId)
        const events = frames.map((frame) => frame.event)
        return summarizeThreadFromEvents(threadId, events)
      }),
    )

    threads.sort((a, b) => b.updatedAt - a.updatedAt)
    return Response.json({ threads })
  }

  if (path === '/api/threaded-chat/threads' && method === 'POST') {
    const created = await engine.createThread()
    const summary = summarizeThreadFromEvents(created.threadId, [])
    return Response.json({ thread: summary }, { status: created.created ? 201 : 200 })
  }

  if (!threadMatch) {
    return new Response('Not Found', { status: 404 })
  }

  const threadId = decodeURIComponent(threadMatch[1] as string)

  if (method === 'PUT') {
    const created = await engine.createThread(threadId)
    return Response.json(
      { threadId: created.threadId, created: created.created },
      { status: created.created ? 201 : 200 },
    )
  }

  if (method === 'GET') {
    const offset = Number(url.searchParams.get('offset') ?? '0')
    const frames = await engine.readThread(threadId, offset)
    const body = frames.map((frame) => JSON.stringify(frame)).join('\n')
    return new Response(body.length > 0 ? `${body}\n` : '', {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
        'X-Thread-Id': threadId,
      },
    })
  }

  if (method === 'POST') {
    const parsed = (await request.json().catch(() => ({}))) as {
      messages?: ThreadMessageInput[]
    }
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.filter((message) => {
          return message.role === 'user' && typeof message.content === 'string'
        })
      : []

    return engine.sendMessage(threadId, messages)
  }

  return new Response('Method Not Allowed', { status: 405 })
}
