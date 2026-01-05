/**
 * Simple test: Effection streaming WITHOUT spawn - just synchronous setup
 */
import { createFileRoute } from '@tanstack/react-router'
import { resource, call } from 'effection'
import type { Operation, Subscription, Stream } from 'effection'
import { createStreamingHandler, useHandlerContext } from '@tanstack/framework/handler'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Simple stream that yields items with delay (no background task)
function createSimpleStream(prefix: string): Stream<string, void> {
  return resource(function* (provide) {
    console.log('[test] simpleStream - setting up')
    let count = 0
    const items = [`${prefix}-one`, `${prefix}-two`, `${prefix}-three`]
    
    const subscription: Subscription<string, void> = {
      *next(): Operation<IteratorResult<string, void>> {
        yield* call(() => sleep(100))
        if (count < items.length) {
          const value = items[count++]
          console.log('[test] simpleStream - yielding:', value)
          return { done: false, value }
        }
        console.log('[test] simpleStream - done')
        return { done: true, value: undefined }
      }
    }
    
    yield* provide(subscription)
  })
}

const testHandler = createStreamingHandler(
  function* () {
    console.log('[test] setup - getting handler context')
    const ctx = yield* useHandlerContext()
    
    console.log('[test] setup - parsing body')
    const body = (yield* call(() => ctx.request.json())) as { prefix?: string }
    const prefix = body.prefix || 'default'
    console.log('[test] setup - got prefix:', prefix)
    
    // NO spawn - just create the stream directly
    console.log('[test] setup - creating simple stream')
    const subscription = yield* createSimpleStream(prefix)
    console.log('[test] setup - returning subscription')
    
    return subscription
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
