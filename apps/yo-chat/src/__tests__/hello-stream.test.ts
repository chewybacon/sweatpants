/**
 * Hello Stream API Route Tests
 *
 * Tests the pull-based streaming handler primitive via HTTP.
 * These tests validate that the createStreamingHandler works in a real server context.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

// We'll test the handler directly without spinning up a server
import { createStreamingHandler, useHandlerContext } from '@sweatpants/framework/handler'
import { resource, sleep, call } from 'effection'
import type { Operation, Stream } from 'effection'

/**
 * Create a simple token stream that yields tokens with delays.
 */
function createTokenStream(tokens: string[], delayMs = 0): Stream<string, void> {
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

describe('Hello Stream API', () => {
  describe('createStreamingHandler integration', () => {
    it('should stream tokens via pull-based ReadableStream', async () => {
      const handler = createStreamingHandler(
        function* () {
          return yield* createTokenStream(['Hello', ' ', 'world', '!'])
        },
        {
          defaultHeaders: { 'Content-Type': 'text/plain' },
          serialize: (v) => v,
        }
      )

      const request = new Request('http://localhost/api/hello-stream')
      const response = await handler(request)

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('text/plain')

      const text = await response.text()
      expect(text).toBe('Hello world!')
    })

    it('should handle POST with custom message from body', async () => {
      const handler = createStreamingHandler(
        function* () {
          const ctx = yield* useHandlerContext()

          let message = 'default'
          if (ctx.request.method === 'POST') {
            const body = (yield* call(() => ctx.request.json())) as { message?: string }
            if (body.message) {
              message = body.message
            }
          }

          // Split message into tokens
          const tokens = message.split('')
          return yield* createTokenStream(tokens)
        },
        {
          serialize: (v) => v,
        }
      )

      const request = new Request('http://localhost/api/hello-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hi!' }),
      })

      const response = await handler(request)
      const text = await response.text()
      expect(text).toBe('Hi!')
    })

    it('should set custom headers from handler context', async () => {
      const handler = createStreamingHandler(
        function* () {
          const ctx = yield* useHandlerContext()
          ctx.headers.set('X-Custom-Header', 'custom-value')
          ctx.headers.set('X-Request-Method', ctx.request.method)

          return yield* createTokenStream(['data'])
        },
        {
          serialize: (v) => v,
        }
      )

      const request = new Request('http://localhost/api/test', {
        method: 'POST',
      })

      const response = await handler(request)

      expect(response.headers.get('X-Custom-Header')).toBe('custom-value')
      expect(response.headers.get('X-Request-Method')).toBe('POST')
    })

    it('should stream NDJSON format with default serializer', async () => {
      const handler = createStreamingHandler(function* () {
        // Return JSON strings
        return yield* createTokenStream([
          JSON.stringify({ type: 'start' }),
          JSON.stringify({ type: 'data', value: 'hello' }),
          JSON.stringify({ type: 'end' }),
        ])
      })

      const request = new Request('http://localhost/api/test')
      const response = await handler(request)

      expect(response.headers.get('Content-Type')).toBe('application/x-ndjson')

      const text = await response.text()
      const lines = text.trim().split('\n')

      expect(lines).toHaveLength(3)
      expect(JSON.parse(lines[0]!)).toEqual({ type: 'start' })
      expect(JSON.parse(lines[1]!)).toEqual({ type: 'data', value: 'hello' })
      expect(JSON.parse(lines[2]!)).toEqual({ type: 'end' })
    })

    it('should handle streaming with delays', async () => {
      const startTime = Date.now()

      const handler = createStreamingHandler(
        function* () {
          return yield* createTokenStream(['a', 'b', 'c'], 20) // 20ms delay each
        },
        {
          serialize: (v) => v,
        }
      )

      const request = new Request('http://localhost/api/test')
      const response = await handler(request)

      const text = await response.text()
      const elapsed = Date.now() - startTime

      expect(text).toBe('abc')
      // Should take at least 60ms (3 tokens * 20ms each)
      expect(elapsed).toBeGreaterThanOrEqual(50) // Allow some slack
    })

    it('should return 500 error if setup throws', async () => {
      const handler = createStreamingHandler(function* () {
        throw new Error('Setup exploded!')
      })

      const request = new Request('http://localhost/api/test')
      const response = await handler(request)

      expect(response.status).toBe(500)
      expect(response.headers.get('Content-Type')).toBe('application/json')

      const body = await response.json()
      expect(body).toEqual({ error: 'Setup exploded!' })
    })

    it('should handle empty stream', async () => {
      const handler = createStreamingHandler(
        function* () {
          return yield* createTokenStream([])
        },
        {
          serialize: (v) => v,
        }
      )

      const request = new Request('http://localhost/api/test')
      const response = await handler(request)

      const text = await response.text()
      expect(text).toBe('')
    })

    it('should handle stream cancellation', async () => {
      let cleanupRan = false

      const infiniteStream: Stream<string, void> = resource(function* (provide) {
        let count = 0
        yield* provide({
          *next(): Operation<IteratorResult<string, void>> {
            yield* sleep(10)
            return { done: false, value: `token-${count++}` }
          },
        })
      })

      const handler = createStreamingHandler(
        function* () {
          return {
            subscription: yield* infiniteStream,
            cleanup: function* () {
              cleanupRan = true
            },
          }
        },
        {
          serialize: (v) => v + '\n',
        }
      )

      const request = new Request('http://localhost/api/test')
      const response = await handler(request)

      const reader = response.body!.getReader()

      // Read a couple tokens
      const { value: chunk1 } = await reader.read()
      const decoder = new TextDecoder()
      expect(decoder.decode(chunk1)).toBe('token-0\n')

      // Cancel the stream
      await reader.cancel()

      // Give cleanup a moment to run
      await new Promise((r) => setTimeout(r, 50))

      expect(cleanupRan).toBe(true)
    })
  })
})
