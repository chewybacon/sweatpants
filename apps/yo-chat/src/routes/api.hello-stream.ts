/**
 * Hello World Streaming API Route
 *
 * A simple test route to validate pull-based streaming with Effection.
 * This uses the createStreamingHandler primitive.
 */
import { createFileRoute } from '@tanstack/react-router'
import { createStreamingHandler, useHandlerContext } from '@tanstack/framework/handler'
import { resource, sleep, call } from 'effection'
import type { Operation, Stream } from 'effection'

/**
 * Create a simple token stream that yields tokens with delays.
 */
function createTokenStream(tokens: string[], delayMs = 50): Stream<string, void> {
  return resource(function* (provide) {
    let index = 0

    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        if (delayMs > 0) {
          yield* sleep(delayMs)
        }

        if (index < tokens.length) {
          return { done: false, value: tokens[index++]! }
        }
        return { done: true, value: undefined }
      },
    })
  })
}

/**
 * Hello world streaming handler.
 * 
 * GET /api/hello-stream - streams "Hello world!" with default delay
 * POST /api/hello-stream - streams custom message from body with optional delay
 * 
 * Request body (POST):
 * {
 *   "message": "Custom message",
 *   "delayMs": 100
 * }
 */
const helloStreamHandler = createStreamingHandler(
  function* () {
    const ctx = yield* useHandlerContext()
    
    let message = 'Hello world!'
    let delayMs = 50

    // Check if POST with body
    if (ctx.request.method === 'POST') {
      try {
        const body = (yield* call(() => ctx.request.json())) as {
          message?: string
          delayMs?: number
        }
        if (body.message) {
          message = body.message
        }
        if (body.delayMs !== undefined) {
          delayMs = body.delayMs
        }
      } catch {
        // Ignore JSON parse errors, use defaults
      }
    }

    // Set custom header to prove context works
    ctx.headers.set('X-Message-Length', String(message.length))

    // Tokenize the message (split by spaces, preserve spaces)
    const words = message.split(' ')
    const tokens: string[] = []
    for (let i = 0; i < words.length; i++) {
      tokens.push(i === 0 ? words[i]! : ' ' + words[i])
    }

    return yield* createTokenStream(tokens, delayMs)
  },
  {
    defaultHeaders: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
    serialize: (v) => v, // No newlines, just raw text
  }
)

export const Route = createFileRoute('/api/hello-stream')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        return helloStreamHandler(request)
      },
      POST: async ({ request }) => {
        return helloStreamHandler(request)
      },
    },
  },
})
