import { parseOffsetParam, toOffsetString } from '@sweatpants/durable-streams'
import type { Message, ToolCall } from '@sweatpants/framework/chat'
import { createStreamResponse } from '@sweatpants/stream-bridge'
import { resource, run, sleep, type Operation, type Stream } from 'effection'

import {
  createEchoElicitRequest,
  ECHO_TOOL_NAME,
  completeEchoTool,
  parseEchoArgs,
} from './echo-tool.ts'
import type {
  ConversationEvent,
  ConversationMessageInput,
  ConversationPostBody,
  ElicitResponseInput,
} from './event-types.ts'
import { createConversationStore, type ConversationStore } from './conversation-store.ts'
import { runLLMTurnOperation } from './llm-client.ts'

export interface DurableConversationHandlerOptions {
  store?: ConversationStore
  generateConversationId?: () => string
  systemPrompt?: string
}

interface EventFrame {
  offset: string
  event: ConversationEvent
}

interface RuntimeWorkItem {
  body: ConversationPostBody
  resolve: () => void
  reject: (error: unknown) => void
}

interface ConversationRuntime {
  queue: RuntimeWorkItem[]
  running: boolean
}

const DEFAULT_SYSTEM_PROMPT = [
  'You are a concise assistant in a durable conversation.',
  'When the user asks to echo, call the echo tool exactly once with {"message":"..."}.',
  'After a tool result arrives, answer plainly with the final result.',
].join(' ')

function parseConversationId(url: URL, generateConversationId: () => string): string {
  const match = url.pathname.match(/^\/conversations(?:\/([^/]+))?$/)
  const pathId = match?.[1]
  if (pathId) {
    return decodeURIComponent(pathId)
  }
  return generateConversationId()
}

function eventToMessage(event: ConversationEvent): Message | null {
  if (event.type === 'message') {
    if (event.from === 'user') {
      return { role: 'user', content: event.content }
    }
    if (event.from === 'assistant') {
      return { role: 'assistant', content: event.content }
    }
    return { role: 'tool', content: event.content }
  }

  if (event.type === 'tool_call' && event.callId && event.toolName && event.arguments) {
    const toolCall: ToolCall = {
      id: event.callId,
      type: 'function',
      function: {
        name: event.toolName,
        arguments: event.arguments,
      },
    }
    return {
      role: 'assistant',
      content: '',
      tool_calls: [toolCall],
    }
  }

  if (event.type === 'tool_result' && event.callId) {
    return {
      role: 'tool',
      tool_call_id: event.callId,
      content: event.content,
    }
  }

  if (event.type === 'elicit_response') {
    return {
      role: 'user',
      content: event.content,
    }
  }

  return null
}

function buildModelMessages(events: ConversationEvent[], systemPrompt: string): Message[] {
  const messages: Message[] = [{ role: 'system', content: systemPrompt }]
  for (const event of events) {
    const message = eventToMessage(event)
    if (message) {
      messages.push(message)
    }
  }
  return messages
}

function createFrameStream(frames: EventFrame[]): Stream<EventFrame, void> {
  return resource(function* (provide) {
    let index = 0
    yield* provide({
      *next(): Operation<IteratorResult<EventFrame, void>> {
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

function createPostReadFrameStream(params: {
  store: ConversationStore
  conversationId: string
  startOffset: number
  completion: Promise<void>
}): Stream<EventFrame, void> {
  const { store, conversationId, startOffset, completion } = params

  return resource(function* (provide) {
    const queue: EventFrame[] = []
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
      *next(): Operation<IteratorResult<EventFrame, void>> {
        if (queue.length > 0) {
          return { done: false, value: queue.shift()! }
        }

        if (done) {
          return { done: true, value: undefined }
        }

        if (completionError) {
          throw completionError
        }

        const events = yield* store.read(conversationId, cursor)
        if (events.length > 0) {
          for (const [index, event] of events.entries()) {
            const offset = cursor + index + 1
            queue.push({
              offset: toOffsetString(offset),
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

        yield* sleep(25)
        return yield* this.next()
      },
    })
  })
}

async function createStreamingNDJSONResponse(
  frameStream: Stream<EventFrame, void>,
  status: number,
  headers: Headers,
): Promise<Response> {
  const bridge = await run(function* () {
    return yield* createStreamResponse(frameStream, {
      contentType: 'application/x-ndjson',
      serialize: (frame) => new TextEncoder().encode(`${JSON.stringify(frame)}\n`),
    })
  })

  const response = new Response(bridge.response.body, {
    status,
    headers,
  })

  headers.forEach((value, key) => {
    response.headers.set(key, value)
  })

  return response
}

function withBaseHeaders(conversationId: string): Headers {
  return new Headers({
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-store',
    'X-Conversation-Id': conversationId,
  })
}

function parseJsonBody(body: unknown): ConversationPostBody {
  if (!body || typeof body !== 'object') {
    return {}
  }
  const value = body as Record<string, unknown>
  const rawMessages = value['messages']
  const messages = Array.isArray(rawMessages)
    ? (rawMessages.filter((message): message is ConversationMessageInput => {
        return (
          typeof message === 'object' &&
          message !== null &&
          typeof (message as Record<string, unknown>)['role'] === 'string' &&
          typeof (message as Record<string, unknown>)['content'] === 'string'
        )
      }) as ConversationMessageInput[])
    : []
  const rawElicitResponses = value['elicitResponses']
  const elicitResponses = Array.isArray(rawElicitResponses)
    ? (rawElicitResponses.filter((response): response is ElicitResponseInput => {
        return (
          typeof response === 'object' &&
          response !== null &&
          typeof (response as Record<string, unknown>)['callId'] === 'string' &&
          typeof (response as Record<string, unknown>)['elicitId'] === 'string' &&
          typeof (response as Record<string, unknown>)['response'] === 'string'
        )
      }) as ElicitResponseInput[])
    : []

  return { messages, elicitResponses }
}

export function createDurableConversationHandler(
  options: DurableConversationHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const store = options.store ?? createConversationStore()
  const generateConversationId = options.generateConversationId ?? (() => crypto.randomUUID())
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  const runOp = <T>(operationFactory: () => Operation<T>): Promise<T> => run(operationFactory)
  const runtimes = new Map<string, ConversationRuntime>()

  const processWorkItem = function* (
    conversationId: string,
    parsedBody: ConversationPostBody,
  ): Operation<void> {
    const emit = function* (
      event: Omit<ConversationEvent, 'id' | 'timestamp'>,
    ): Operation<void> {
      yield* store.appendEvent(conversationId, event)
    }

    for (const response of parsedBody.elicitResponses ?? []) {
      yield* emit({
        from: 'user',
        type: 'elicit_response',
        content: response.response,
        callId: response.callId,
        elicitId: response.elicitId,
      })

      const pending = store.resolvePendingTool(conversationId, response)
      if (pending && pending.toolName === ECHO_TOOL_NAME) {
        const result = completeEchoTool(parseEchoArgs(pending.args), response)
        yield* emit({
          from: 'tool',
          type: 'tool_result',
          content: result,
          callId: pending.callId,
          toolName: pending.toolName,
        })
      }
    }

    for (const message of parsedBody.messages ?? []) {
      if (message.role !== 'user') {
        continue
      }
      yield* emit({
        from: 'user',
        type: 'message',
        content: message.content,
      })
    }

    const allEvents = yield* store.read(conversationId, 0)
    if (allEvents.length === 0) {
      return
    }

    const hasElicitResponse = (parsedBody.elicitResponses?.length ?? 0) > 0
    const modelMessages = buildModelMessages(allEvents, systemPrompt)
    const llmResult = yield* runLLMTurnOperation(modelMessages, {
      allowTools: !hasElicitResponse,
      requireTool: !hasElicitResponse,
    })

    const firstToolCall = llmResult.toolCalls.find((call) => call.function.name === ECHO_TOOL_NAME)

    if (firstToolCall && !hasElicitResponse) {
      yield* emit({
        from: 'assistant',
        type: 'tool_call',
        content: `Calling ${firstToolCall.function.name}`,
        callId: firstToolCall.id,
        toolName: firstToolCall.function.name,
        arguments: firstToolCall.function.arguments,
      })

      const args = parseEchoArgs(firstToolCall.function.arguments)
      const elicit = createEchoElicitRequest(firstToolCall.id, args)
      store.registerPendingTool(conversationId, {
        callId: elicit.callId,
        elicitId: elicit.elicitId,
        toolName: ECHO_TOOL_NAME,
        args,
      })

      yield* emit({
        from: 'tool',
        type: 'elicit_request',
        content: elicit.message,
        callId: elicit.callId,
        elicitId: elicit.elicitId,
        toolName: ECHO_TOOL_NAME,
      })
      return
    }

    if (llmResult.text.trim().length > 0) {
      yield* emit({
        from: 'assistant',
        type: 'message',
        content: llmResult.text,
      })
    }
  }

  const enqueueWork = (conversationId: string, parsedBody: ConversationPostBody): Promise<void> => {
    const runtime = runtimes.get(conversationId) ?? { queue: [], running: false }
    runtimes.set(conversationId, runtime)

    const runRuntimeQueue = () => {
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
            yield* processWorkItem(conversationId, item.body)
            item.resolve()
          } catch (error) {
            item.reject(error)
          }
        }
      })
        .catch((error) => {
          while (runtime.queue.length > 0) {
            const item = runtime.queue.shift()
            item?.reject(error)
          }
        })
        .finally(() => {
          runtime.running = false
          if (runtime.queue.length > 0) {
            runRuntimeQueue()
          }
        })
    }

    const completion = new Promise<void>((resolve, reject) => {
      runtime.queue.push({
        body: parsedBody,
        resolve,
        reject,
      })
    })

    runRuntimeQueue()

    return completion
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)

    if (!url.pathname.startsWith('/conversations')) {
      return new Response('Not Found', { status: 404 })
    }

    const conversationId = parseConversationId(url, generateConversationId)
    const headers = withBaseHeaders(conversationId)
    const method = request.method.toUpperCase()

    if (method === 'PUT') {
      const { created } = await runOp(() => store.create(conversationId))
      headers.set('Stream-Next-Offset', await runOp(() => store.nextOffsetString(conversationId)))
      return new Response('', {
        status: created ? 201 : 200,
        headers,
      })
    }

    if (method === 'GET') {
      const parsedOffset = parseOffsetParam(url.searchParams.get('offset'))
      const offset = parsedOffset.value ?? 0
      const events = await runOp(() => store.read(conversationId, offset))
      const frames = events.map((event, index) => ({
        offset: toOffsetString(offset + index + 1),
        event,
      }))

      headers.set('Stream-Next-Offset', await runOp(() => store.nextOffsetString(conversationId)))
      headers.set('Stream-Up-To-Date', 'true')

      return createStreamingNDJSONResponse(createFrameStream(frames), 200, headers)
    }

    if (method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers,
      })
    }

    await runOp(() => store.create(conversationId))

    const parsedBody = parseJsonBody(await request.json().catch(() => ({})))

    const hasAnyInput =
      (parsedBody.messages?.some((message) => message.role === 'user') ?? false) ||
      (parsedBody.elicitResponses?.length ?? 0) > 0

    if (!hasAnyInput) {
      headers.set('Stream-Next-Offset', await runOp(() => store.nextOffsetString(conversationId)))
      return new Response('', { status: 204, headers })
    }

    const startOffset = await runOp(() => store.nextOffset(conversationId))
    const completion = enqueueWork(conversationId, parsedBody)

    headers.set('Stream-Next-Offset', toOffsetString(startOffset))

    const postFrameStream = createPostReadFrameStream({
      store,
      conversationId,
      startOffset,
      completion,
    })

    return createStreamingNDJSONResponse(postFrameStream, 200, headers)
  }
}
