/**
 * Pull-Based Effection Web Stream Bridge Tests
 *
 * Validates the core pattern for bridging Effection operations to
 * pull-based ReadableStream for HTTP responses.
 *
 * The pattern:
 * 1. Create scope in handler
 * 2. Initialize subscription via scope.run()
 * 3. ReadableStream.pull() calls scope.run(() => subscription.next())
 * 4. Cleanup scope on completion or cancel
 */
import { describe, it, expect } from './vitest-effection.ts'
import { createScope, resource, sleep, call } from 'effection'
import type { Operation, Stream } from 'effection'
import { createStreamingHandler, useHandlerContext } from '../../streaming.ts'

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a simple Effection stream from an array of tokens.
 * Optionally adds delay between tokens to simulate async work.
 */
function createTokenStream(
  tokens: string[],
  delayMs = 0
): Stream<string, void> {
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
 * Consume a ReadableStream and return all chunks as strings.
 */
async function consumeStream(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(decoder.decode(value))
  }

  return chunks
}

// =============================================================================
// TESTS
// =============================================================================

describe('Pull-Based Effection Web Stream Bridge', () => {
  describe('Test 1: Basic pull-based streaming', () => {
    it('should stream tokens via pull() with scope.run()', function* () {
      const tokens = ['Hello', ' ', 'world', '!']

      // This is the pattern we're validating:
      // 1. Create scope
      const [scope, destroy] = createScope()
      const encoder = new TextEncoder()

      try {
        // 2. Initialize subscription in scope
        const subscription = yield* call(() =>
          scope.run(function* () {
            return yield* createTokenStream(tokens)
          })
        )

        // 3. Create ReadableStream with pull()
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const result = await scope.run(function* () {
              return yield* subscription.next()
            })

            if (result.done) {
              controller.close()
            } else {
              controller.enqueue(encoder.encode(result.value))
            }
          },
        })

        // 4. Consume and verify
        const chunks = yield* call(() => consumeStream(stream))

        expect(chunks).toEqual(['Hello', ' ', 'world', '!'])
      } finally {
        yield* call(() => destroy())
      }
    })

    it('should work with async delays between tokens', function* () {
      const tokens = ['async', '-', 'tokens']

      const [scope, destroy] = createScope()
      const encoder = new TextEncoder()

      try {
        const subscription = yield* call(() =>
          scope.run(function* () {
            return yield* createTokenStream(tokens, 10) // 10ms delay
          })
        )

        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const result = await scope.run(function* () {
              return yield* subscription.next()
            })

            if (result.done) {
              controller.close()
            } else {
              controller.enqueue(encoder.encode(result.value))
            }
          },
        })

        const chunks = yield* call(() => consumeStream(stream))

        expect(chunks).toEqual(['async', '-', 'tokens'])
      } finally {
        yield* call(() => destroy())
      }
    })
  })

  describe('Test 2: Handler context (headers, request access)', () => {
    it('should allow setup operation to set response headers', function* () {
      const tokens = ['data']

      // Simulate handler context
      interface HandlerContext {
        request: Request
        headers: Headers
      }

      const ctx: HandlerContext = {
        request: new Request('http://test.com', {
          method: 'POST',
          body: JSON.stringify({ sessionId: 'test-123' }),
        }),
        headers: new Headers({ 'Content-Type': 'application/x-ndjson' }),
      }

      const [scope, destroy] = createScope()
      const encoder = new TextEncoder()

      try {
        // Setup operation has access to context
        const subscription = yield* call(() =>
          scope.run(function* () {
            // Read from request
            const body = (yield* call(() => ctx.request.json())) as { sessionId: string }

            // Set header based on request data
            ctx.headers.set('X-Session-Id', body.sessionId)

            return yield* createTokenStream(tokens)
          })
        )

        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const result = await scope.run(function* () {
              return yield* subscription.next()
            })

            if (result.done) {
              controller.close()
            } else {
              controller.enqueue(encoder.encode(result.value))
            }
          },
        })

        // Create response with headers set during setup
        const response = new Response(stream, { headers: ctx.headers })

        // Verify headers were set
        expect(response.headers.get('Content-Type')).toBe('application/x-ndjson')
        expect(response.headers.get('X-Session-Id')).toBe('test-123')

        // Verify body streams correctly
        const text = yield* call(() => response.text())
        expect(text).toBe('data')
      } finally {
        yield* call(() => destroy())
      }
    })
  })

  describe('Test 3: Cleanup on stream completion', () => {
    it('should destroy scope when stream completes', function* () {
      const tokens = ['a', 'b']
      let scopeDestroyed = false
      let destroyPromise: Promise<void> | null = null

      const [scope, destroy] = createScope()
      const encoder = new TextEncoder()

      const subscription = yield* call(() =>
        scope.run(function* () {
          return yield* createTokenStream(tokens)
        })
      )

      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const result = await scope.run(function* () {
            return yield* subscription.next()
          })

          if (result.done) {
            controller.close()
            destroyPromise = destroy().then(() => {
              scopeDestroyed = true
            })
          } else {
            controller.enqueue(encoder.encode(result.value))
          }
        },
      })

      // Consume the stream
      const chunks = yield* call(() => consumeStream(stream))

      // Wait for cleanup to complete
      if (destroyPromise) {
        yield* call(() => destroyPromise)
      }

      expect(chunks).toEqual(['a', 'b'])
      expect(scopeDestroyed).toBe(true)
    })
  })

  describe('Test 4: Cleanup on client disconnect (cancel)', () => {
    it('should destroy scope when stream is cancelled', function* () {
      // Stream that would go on forever
      const infiniteStream: Stream<string, void> = resource(function* (provide) {
        let count = 0
        yield* provide({
          *next(): Operation<IteratorResult<string, void>> {
            yield* sleep(10)
            return { done: false, value: `token-${count++}` }
          },
        })
      })

      let scopeDestroyed = false

      const [scope, destroy] = createScope()
      const encoder = new TextEncoder()

      const subscription = yield* call(() =>
        scope.run(function* () {
          return yield* infiniteStream
        })
      )

      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await scope.run(function* () {
              return yield* subscription.next()
            })

            if (result.done) {
              controller.close()
              await destroy()
              scopeDestroyed = true
            } else {
              controller.enqueue(encoder.encode(result.value))
            }
          } catch {
            // Scope was destroyed, close the stream
            controller.close()
          }
        },
        async cancel() {
          await destroy()
          scopeDestroyed = true
        },
      })

      const reader = stream.getReader()

      // Read a couple tokens
      const { value: chunk1 } = yield* call(() => reader.read())
      const { value: chunk2 } = yield* call(() => reader.read())

      const decoder = new TextDecoder()
      expect(decoder.decode(chunk1!)).toBe('token-0')
      expect(decoder.decode(chunk2!)).toBe('token-1')

      // Cancel the stream (simulates client disconnect)
      yield* call(() => reader.cancel())

      expect(scopeDestroyed).toBe(true)
    })
  })
})

// =============================================================================
// TESTS FOR createStreamingHandler PRIMITIVE
// =============================================================================

describe('createStreamingHandler Primitive', () => {
  describe('Basic streaming', () => {
    it('should create handler that streams from subscription', function* () {
      const tokens = ['Hello', ' ', 'world']

      const handler = createStreamingHandler(function* () {
        return yield* createTokenStream(tokens)
      })

      const request = new Request('http://test.com')
      const response = yield* call(() => handler(request))

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/x-ndjson')

      const text = yield* call(() => response.text())
      expect(text).toBe('Hello\n \nworld\n')
    })

    it('should handle async token streams', function* () {
      const tokens = ['async', 'stream']

      const handler = createStreamingHandler(function* () {
        return yield* createTokenStream(tokens, 10)
      })

      const request = new Request('http://test.com')
      const response = yield* call(() => handler(request))

      const text = yield* call(() => response.text())
      expect(text).toBe('async\nstream\n')
    })
  })

  describe('Handler context', () => {
    it('should allow setup to access request via context', function* () {
      const handler = createStreamingHandler(function* () {
        const ctx = yield* useHandlerContext()
        const body = (yield* call(() => ctx.request.json())) as { message: string }

        // Echo the message back as tokens
        return yield* createTokenStream([body.message])
      })

      const request = new Request('http://test.com', {
        method: 'POST',
        body: JSON.stringify({ message: 'echoed' }),
      })

      const response = yield* call(() => handler(request))
      const text = yield* call(() => response.text())
      expect(text).toBe('echoed\n')
    })

    it('should allow setup to set response headers', function* () {
      const handler = createStreamingHandler(function* () {
        const ctx = yield* useHandlerContext()
        ctx.headers.set('X-Custom-Header', 'custom-value')
        ctx.headers.set('X-Session-Id', 'session-123')

        return yield* createTokenStream(['data'])
      })

      const request = new Request('http://test.com')
      const response = yield* call(() => handler(request))

      expect(response.headers.get('X-Custom-Header')).toBe('custom-value')
      expect(response.headers.get('X-Session-Id')).toBe('session-123')
      expect(response.headers.get('Content-Type')).toBe('application/x-ndjson')
    })

    it('should allow setup to set response status', function* () {
      const handler = createStreamingHandler(function* () {
        const ctx = yield* useHandlerContext()
        ctx.status = 201

        return yield* createTokenStream(['created'])
      })

      const request = new Request('http://test.com')
      const response = yield* call(() => handler(request))

      expect(response.status).toBe(201)
    })
  })

  describe('Error handling', () => {
    it('should return 500 response if setup throws', function* () {
      const handler = createStreamingHandler(function* () {
        throw new Error('Setup failed!')
      })

      const request = new Request('http://test.com')
      const response = yield* call(() => handler(request))

      expect(response.status).toBe(500)
      expect(response.headers.get('Content-Type')).toBe('application/json')

      const body = (yield* call(() => response.json())) as { error: string }
      expect(body.error).toBe('Setup failed!')
    })
  })

  describe('Cleanup', () => {
    it('should run cleanup function on stream completion', function* () {
      let cleanupRan = false

      const handler = createStreamingHandler(function* () {
        return {
          subscription: yield* createTokenStream(['a', 'b']),
          cleanup: function* () {
            cleanupRan = true
          },
        }
      })

      const request = new Request('http://test.com')
      const response = yield* call(() => handler(request))

      // Consume the stream fully
      yield* call(() => response.text())

      // Give cleanup a moment to run
      yield* sleep(10)

      expect(cleanupRan).toBe(true)
    })

    it('should run cleanup function on cancel', function* () {
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

      const handler = createStreamingHandler(function* () {
        return {
          subscription: yield* infiniteStream,
          cleanup: function* () {
            cleanupRan = true
          },
        }
      })

      const request = new Request('http://test.com')
      const response = yield* call(() => handler(request))

      const reader = response.body!.getReader()

      // Read one token
      yield* call(() => reader.read())

      // Cancel
      yield* call(() => reader.cancel())

      // Give cleanup a moment to run
      yield* sleep(10)

      expect(cleanupRan).toBe(true)
    })
  })

  describe('Options', () => {
    it('should respect custom default headers', function* () {
      const handler = createStreamingHandler(
        function* () {
          return yield* createTokenStream(['data'])
        },
        {
          defaultHeaders: {
            'Content-Type': 'text/plain',
            'X-Default': 'yes',
          },
        }
      )

      const request = new Request('http://test.com')
      const response = yield* call(() => handler(request))

      expect(response.headers.get('Content-Type')).toBe('text/plain')
      expect(response.headers.get('X-Default')).toBe('yes')
    })

    it('should respect custom serializer', function* () {
      const handler = createStreamingHandler(
        function* () {
          return yield* createTokenStream(['a', 'b'])
        },
        {
          serialize: (v) => `[${v}]`,
        }
      )

      const request = new Request('http://test.com')
      const response = yield* call(() => handler(request))

      const text = yield* call(() => response.text())
      expect(text).toBe('[a][b]')
    })
  })
})
