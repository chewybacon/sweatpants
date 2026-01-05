/**
 * Test route for Effection streaming - used to debug streaming behavior.
 * This route demonstrates how to create a streaming handler using the framework.
 */
import { createFileRoute } from '@tanstack/react-router'
import { resource, call } from 'effection'
import type { Operation, Stream } from 'effection'
import { createStreamingHandler, useHandlerContext } from '@tanstack/framework/handler'
import { setupInMemoryDurableStreams, createPullStream } from '@tanstack/framework/chat/durable-streams'
import { ollamaProvider } from '@tanstack/framework/chat'
import type { TokenBuffer } from '@tanstack/framework/chat/durable-streams'
import { createChatEngine } from '@tanstack/framework/handler/durable'
import type { StreamEvent } from '@tanstack/framework/handler'

/**
 * Wrap the chat engine to serialize events to strings
 */
function createSerializedEngineStream(
  engine: Stream<StreamEvent, void>
): Stream<string, void> {
  return resource(function* (provide) {
    const subscription = yield* engine

    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        const result = yield* subscription.next()
        if (result.done) {
          return { done: true, value: undefined }
        }
        return { done: false, value: JSON.stringify(result.value) }
      },
    })
  })
}

function createDurableEventStream(
  buffer: TokenBuffer<string>,
  startLSN: number
): Stream<string, void> {
  return resource(function* (provide) {
    const pullStream = yield* createPullStream(buffer, startLSN)
    let lastLSN = startLSN
    let errorEmitted = false
    
    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        if (errorEmitted) {
          return { done: true, value: undefined }
        }
        
        try {
          const result = yield* pullStream.next()
          if (result.done) {
            return { done: true, value: undefined }
          }
          const frame = result.value
          lastLSN = frame.lsn
          const durableEvent = { lsn: frame.lsn, event: JSON.parse(frame.token) }
          return { done: false, value: JSON.stringify(durableEvent) }
        } catch (error) {
          errorEmitted = true
          const errorEvent = {
            lsn: lastLSN + 1,
            event: {
              type: 'error',
              message: error instanceof Error ? error.message : 'Unknown error',
              recoverable: false,
            },
          }
          return { done: false, value: JSON.stringify(errorEvent) }
        }
      },
    })
  })
}

const testHandler = createStreamingHandler(
  function* () {
    const ctx = yield* useHandlerContext()
    
    const body = (yield* call(() => ctx.request.json())) as { 
      messages?: Array<{ role: string; content: string }>
    }
    const messages = body.messages || [{ role: 'user', content: 'Hi' }]
    
    // Setup durable streams
    const { registry } = yield* setupInMemoryDurableStreams<string>()
    
    // Create our own AbortController for the chat engine.
    // NOTE: We cannot use request.signal directly because TanStack Start
    // aborts it after reading the body, before the response is sent.
    const engineAbortController = new AbortController()
    
    // Create chat engine
    const engine = createChatEngine({
      messages: messages as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
      toolSchemas: [],
      toolRegistry: {
        get: () => undefined,
        has: () => false,
        names: () => [],
      },
      clientIsomorphicTools: [],
      isomorphicClientOutputs: [],
      provider: ollamaProvider,
      maxIterations: 10,
      signal: engineAbortController.signal,
      sessionInfo: {
        type: 'session_info',
        capabilities: { thinking: true, streaming: true, tools: [] },
        persona: null,
      },
    })
    
    // Wrap engine in serialized stream
    const serializedStream = createSerializedEngineStream(engine)
    
    // Acquire session with chat engine as source
    const sessionId = crypto.randomUUID()
    const session = yield* registry.acquire(sessionId, { source: serializedStream })
    
    // Create durable event stream from buffer
    const durableStream = createDurableEventStream(session.buffer, 0)
    const durableSubscription = yield* durableStream
    
    return {
      subscription: durableSubscription,
      cleanup: function* () {
        yield* registry.release(sessionId)
      }
    }
  },
  {
    serialize: (v) => v + '\n',
  }
)

export const Route = createFileRoute('/api/test-effection-stream')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return testHandler(request)
      }
    }
  }
})
