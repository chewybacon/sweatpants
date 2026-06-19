import {
  createInMemoryBufferStore,
  createRedisTokenBufferStore,
  type TokenBuffer,
  type TokenBufferStore,
} from '@sweatpants/framework/chat/durable-streams'
import type {
  ChatEvent,
  ChatResult,
  Message,
} from '@sweatpants/framework/chat'
import { ollamaProvider, openaiProvider } from '@sweatpants/framework/chat/providers'
import { call, race, resource, run, type Operation, type Stream, type Task } from 'effection'
import type { RedisClientType } from 'redis'
import type { ThreadEvent, ThreadFrame, ThreadMessageInput } from './threaded-chat-types'
export type { ThreadEvent, ThreadFrame, ThreadMessageInput } from './threaded-chat-types'

export interface ThreadStore {
  create(threadId: string): Operation<{ created: boolean; buffer: TokenBuffer<ThreadEvent> }>
  read(threadId: string, offset: number): Operation<ThreadEvent[]>
  appendEvent(
    threadId: string,
    event: Omit<ThreadEvent, 'id' | 'timestamp'>,
  ): Operation<ThreadEvent>
  waitForChange(threadId: string, afterOffset: number): Operation<void>
  nextOffset(threadId: string): Operation<number>
}

interface RuntimeWorkItem {
  input: ThreadMessageInput[]
  resolve: () => void
  reject: (error: unknown) => void
}

interface ThreadRuntime {
  queue: RuntimeWorkItem[]
  running: boolean
}

interface ChatProviderLike {
  stream(messages: Message[], options?: unknown): Stream<ChatEvent, ChatResult>
}

export interface ThreadedChatEngine {
  listThreadIds(): string[]
  createThread(threadId?: string): Promise<{ threadId: string; created: boolean }>
  readThread(threadId: string, offset?: number): Promise<ThreadFrame[]>
  sendMessage(threadId: string, input: ThreadMessageInput[]): Promise<Response>
}

function createFrameStream(frames: ThreadFrame[]): Stream<ThreadFrame, void> {
  return resource(function* (provide) {
    let index = 0
    yield* provide({
      *next(): Operation<IteratorResult<ThreadFrame, void>> {
        if (index >= frames.length) {
          return { done: true, value: undefined }
        }
        const value = frames[index]
        index += 1
        return { done: false, value: value! }
      },
    })
  })
}

function createTailFrameStream(params: {
  store: ThreadStore
  threadId: string
  startOffset: number
  completion: Promise<void>
}): Stream<ThreadFrame, void> {
  const { store, threadId, startOffset, completion } = params

  return resource(function* (provide) {
    const queue: ThreadFrame[] = []
    let done = false
    let completionSettled = false
    let completionError: unknown = null
    let cursor = startOffset

    completion.then(
      () => {
        completionSettled = true
      },
      (error) => {
        completionError = error
        completionSettled = true
      },
    )

    yield* provide({
      *next(): Operation<IteratorResult<ThreadFrame, void>> {
        return yield* (function* loop(): Operation<IteratorResult<ThreadFrame, void>> {
          if (queue.length > 0) {
            return { done: false, value: queue.shift()! }
          }

          if (done) {
            return { done: true, value: undefined }
          }

          if (completionError) {
            throw completionError
          }

          const events = yield* store.read(threadId, cursor)
          if (events.length > 0) {
            for (const [index, event] of events.entries()) {
              queue.push({
                offset: String(cursor + index + 1),
                event,
              })
            }
            cursor += events.length
            return { done: false, value: queue.shift()! }
          }

          if (completionSettled) {
            done = true
            return { done: true, value: undefined }
          }

          yield* race([
            (function* (): Operation<'changed'> {
              yield* store.waitForChange(threadId, cursor)
              return 'changed'
            })(),
            (function* (): Operation<'done'> {
              yield* call(() => completion)
              return 'done'
            })(),
          ])

          return yield* loop()
        })()
      },
    })
  })
}

async function createStreamingNDJSONResponse(
  frameStream: Stream<ThreadFrame, void>,
  status: number,
  headers: Headers,
): Promise<Response> {
  let task: Task<void> | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      task = run(function* () {
        const subscription = yield* frameStream
        while (true) {
          const next = yield* subscription.next()
          if (next.done) {
            controller.close()
            break
          }

          controller.enqueue(
            new TextEncoder().encode(`${JSON.stringify(next.value)}\n`),
          )
        }
      })
      task.catch((error) => {
        controller.error(error)
      })
    },
    async cancel() {
      if (task) {
        await task.halt().catch(() => undefined)
      }
    },
  })

  const responseHeaders = new Headers(headers)
  responseHeaders.set('Content-Type', 'application/x-ndjson')

  return new Response(stream, {
    status,
    headers: responseHeaders,
  })
}

function buildMessages(events: ThreadEvent[], systemPrompt: string): Message[] {
  const messages: Message[] = [{ role: 'system', content: systemPrompt }]

  for (const event of events) {
    if (event.type === 'user_message') {
      messages.push({ role: 'user', content: event.content })
      continue
    }

    if (event.type === 'assistant_message_complete') {
      messages.push({ role: 'assistant', content: event.content })
    }
  }

  return messages
}

function createThreadStore(bufferStore: TokenBufferStore<ThreadEvent>): ThreadStore {
  const create = function* (
    threadId: string,
  ): Operation<{ created: boolean; buffer: TokenBuffer<ThreadEvent> }> {
    const existing = yield* bufferStore.get(threadId)
    if (existing) {
      return { created: false, buffer: existing }
    }
    const buffer = yield* bufferStore.create(threadId)
    return { created: true, buffer }
  }

  return {
    create,

    *read(threadId, offset) {
      const buffer = yield* bufferStore.get(threadId)
      if (!buffer) {
        return []
      }
      const { tokens } = yield* buffer.read(offset)
      return tokens
    },

    *appendEvent(threadId, event) {
      const { buffer } = yield* create(threadId)
      const { lsn } = yield* buffer.read(Number.MAX_SAFE_INTEGER)
      const next: ThreadEvent = {
        ...event,
        id: `${threadId}:${lsn + 1}`,
        timestamp: Date.now(),
      }
      yield* buffer.append([next])
      return next
    },

    *waitForChange(threadId, afterOffset) {
      const buffer = yield* bufferStore.get(threadId)
      if (!buffer) {
        return
      }
      yield* buffer.waitForChange(afterOffset)
    },

    *nextOffset(threadId) {
      const buffer = yield* bufferStore.get(threadId)
      if (!buffer) {
        return 0
      }
      const { lsn } = yield* buffer.read(Number.MAX_SAFE_INTEGER)
      return lsn
    },
  }
}

function parseProviderEvent(event: ChatEvent): string | null {
  if (event.type === 'text') {
    return event.content
  }
  return null
}

function selectProvider(name: 'ollama' | 'openai'): ChatProviderLike {
  return name === 'openai' ? openaiProvider : ollamaProvider
}

export function createThreadedChatEngine(params: {
  bufferStore: TokenBufferStore<ThreadEvent>
  providerName: 'ollama' | 'openai'
  systemPrompt: string
}): ThreadedChatEngine {
  const { bufferStore, providerName, systemPrompt } = params
  const store = createThreadStore(bufferStore)
  const provider = selectProvider(providerName)
  const knownThreadIds = new Set<string>()
  const runtimes = new Map<string, ThreadRuntime>()
  const runOp = <T>(factory: () => Operation<T>): Promise<T> => run(factory)

  const processQueueItem = function* (
    threadId: string,
    input: ThreadMessageInput[],
  ): Operation<void> {
    for (const message of input) {
      yield* store.appendEvent(threadId, {
        from: 'user',
        type: 'user_message',
        content: message.content,
      })
    }

    const history = yield* store.read(threadId, 0)
    const messages = buildMessages(history, systemPrompt)
    const assistantMessageId = crypto.randomUUID()
    let assistantText = ''

    const stream = provider.stream(messages)
    const subscription = yield* stream

    while (true) {
      const next = yield* subscription.next()
      if (next.done) {
        if (!assistantText.trim() && next.value.text.trim()) {
          assistantText = next.value.text
        }
        break
      }

      const chunk = parseProviderEvent(next.value)
      if (!chunk) {
        continue
      }

      assistantText += chunk
      yield* store.appendEvent(threadId, {
        from: 'assistant',
        type: 'assistant_message_delta',
        content: chunk,
        messageId: assistantMessageId,
      })
    }

    if (assistantText.trim()) {
      yield* store.appendEvent(threadId, {
        from: 'assistant',
        type: 'assistant_message_complete',
        content: assistantText,
        messageId: assistantMessageId,
      })
    }
  }

  const enqueueTurn = (threadId: string, input: ThreadMessageInput[]): Promise<void> => {
    const runtime = runtimes.get(threadId) ?? { queue: [], running: false }
    runtimes.set(threadId, runtime)

    const runQueue = () => {
      if (runtime.running) {
        return
      }

      runtime.running = true
      void run(function* () {
        while (runtime.queue.length > 0) {
          const item = runtime.queue.shift()
          if (!item) {
            continue
          }
          try {
            yield* processQueueItem(threadId, item.input)
            item.resolve()
          } catch (error) {
            item.reject(error)
          }
        }
      })
        .catch((error) => {
          while (runtime.queue.length > 0) {
            runtime.queue.shift()?.reject(error)
          }
        })
        .finally(() => {
          runtime.running = false
          if (runtime.queue.length > 0) {
            runQueue()
          }
        })
    }

    const completion = new Promise<void>((resolve, reject) => {
      runtime.queue.push({ input, resolve, reject })
    })
    runQueue()
    return completion
  }

  return {
    listThreadIds() {
      return Array.from(knownThreadIds)
    },

    async createThread(threadId = crypto.randomUUID()) {
      const { created } = await runOp(() => store.create(threadId))
      knownThreadIds.add(threadId)
      return { threadId, created }
    },

    async readThread(threadId, offset = 0) {
      const events = await runOp(() => store.read(threadId, offset))
      return events.map((event, index) => ({
        offset: String(offset + index + 1),
        event,
      }))
    },

    async sendMessage(threadId, input) {
      knownThreadIds.add(threadId)
      await this.createThread(threadId)
      const startOffset = await runOp(() => store.nextOffset(threadId))
      const completion = enqueueTurn(threadId, input)
      const headers = new Headers({
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
        'X-Thread-Id': threadId,
        'Stream-Next-Offset': String(startOffset),
      })

      return createStreamingNDJSONResponse(
        createTailFrameStream({
          store,
          threadId,
          startOffset,
          completion,
        }),
        200,
        headers,
      )
    },
  }
}

export function createThreadBufferStore(
  redisClient: RedisClientType | null,
): TokenBufferStore<ThreadEvent> {
  if (!redisClient) {
    return createInMemoryBufferStore<ThreadEvent>()
  }

  return createRedisTokenBufferStore<ThreadEvent>(redisClient, {
    keyPrefix: 'threaded-chat:',
  })
}
