/**
 * Approach 4: Effection-Native Server
 *
 * A minimal HTTP server abstraction where handlers return Operation<Response>
 * instead of Promise<Response>. This allows handlers to use Effection streams
 * directly without bridging.
 *
 * The key insight: if the entire server runs inside an Effection main,
 * we can use Effection's structured concurrency throughout.
 *
 * Pros:
 * - No bridge needed - fully Effection-native
 * - Clean handler API with yield*
 * - Automatic cleanup on shutdown
 *
 * Cons:
 * - Requires wrapping the underlying HTTP server
 * - Runtime-specific (Deno vs Node)
 */

import { run, spawn, call, type Operation, type Stream } from 'effection'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface EffectionHandler {
  (request: Request): Operation<Response>
}

export interface EffectionServerOptions {
  port?: number
  hostname?: string
}

export interface EffectionServer {
  /** The server address */
  address: { port: number; hostname: string }
  /** Wait for server to close */
  closed: Operation<void>
  /** Stop the server */
  stop: () => void
}

/**
 * Creates an HTTP server where handlers are Effection Operations.
 *
 * The handler receives a standard Request and returns an Operation<Response>.
 * For streaming responses, the body can be an Effection Stream directly.
 *
 * @example
 * ```typescript
 * const server = yield* createEffectionServer({
 *   port: 3000,
 *   handler: function* (req) {
 *     const { stream, pullLog } = createCountingGenerator({ maxCount: 10 })
 *     const subscription = yield* stream
 *
 *     // Build response body by pulling from stream
 *     const body = yield* createStreamBody(subscription)
 *     return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })
 *   }
 * })
 * ```
 */
export function createEffectionServer(
  options: EffectionServerOptions & { handler: EffectionHandler }
): Operation<EffectionServer> {
  const { port = 3000, hostname = 'localhost', handler } = options

  return {
    *[Symbol.iterator]() {
      let resolveClosed: () => void
      const closedPromise = new Promise<void>((resolve) => {
        resolveClosed = resolve
      })

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        handleRequestWithEffection(req, res, handler)
      })

      yield* call(async () => {
        await new Promise<void>((resolve) => {
          server.listen(port, hostname, () => resolve())
        })
      })

      const address = server.address() as { port: number; address: string }

      const stop = () => {
        server.close(() => {
          resolveClosed()
        })
      }

      const closed: Operation<void> = {
        *[Symbol.iterator]() {
          yield* call(() => closedPromise)
        },
      }

      yield* spawn(function* () {
        yield* call(async () => {
          await new Promise<void>((resolve) => {
            server.on('close', resolve)
          })
          resolveClosed()
        })
      })

      return {
        address: { port: address.port, hostname: address.address || hostname },
        closed,
        stop,
      }
    },
  }
}

/**
 * Handles an incoming HTTP request using an Effection handler.
 *
 * This bridges Node's callback-based API to Effection's Operation-based API.
 */
function handleRequestWithEffection(
  req: IncomingMessage,
  res: ServerResponse,
  handler: EffectionHandler
): void {
  run(function* () {
    try {
      const webRequest = nodeRequestToWebRequest(req)
      const webResponse = yield* handler(webRequest)

      res.statusCode = webResponse.status
      webResponse.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })

      if (webResponse.body) {
        yield* pipeBodyToResponse(webResponse.body, res)
      }

      res.end()
    } catch (err) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
  }).catch((err) => {
    console.error('Handler error:', err)
    if (!res.headersSent) {
      res.statusCode = 500
      res.end('Internal Server Error')
    }
  })
}

/**
 * Converts a Node.js IncomingMessage to a Web standard Request.
 */
function nodeRequestToWebRequest(req: IncomingMessage): Request {
  const protocol = 'http'
  const host = req.headers.host || 'localhost'
  const url = `${protocol}://${host}${req.url}`

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
  }

  return new Request(url, {
    method: req.method || 'GET',
    headers,
    body: null,
  })
}

/**
 * Pipes a Response body to a Node.js ServerResponse.
 */
function pipeBodyToResponse(body: BodyInit, res: ServerResponse): Operation<void> {
  return {
    *[Symbol.iterator]() {
      if (body instanceof ReadableStream) {
        const reader = body.getReader()
        try {
          while (true) {
            const { done, value } = yield* call(() => reader.read())
            if (done) break
            res.write(value)
          }
        } finally {
          reader.releaseLock()
        }
      } else if (body && typeof (body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
        // Handle async iterable - need to iterate asynchronously
        const iterable = body as unknown as AsyncIterable<Uint8Array>
        yield* call(async () => {
          for await (const chunk of iterable) {
            res.write(chunk)
          }
        })
      } else if (typeof body === 'string') {
        res.write(body)
      } else if (body instanceof Uint8Array) {
        res.write(body)
      }
    },
  }
}

/**
 * Creates a streaming Response body from an Effection Stream.
 *
 * This is the "native" way - no ReadableStream, just an async iterable
 * that pulls from the Effection stream.
 */
export function createStreamBody<T>(
  stream: Stream<T, void>,
  serialize: (value: T) => Uint8Array = (v) => new TextEncoder().encode(JSON.stringify(v) + '\n')
): Operation<AsyncIterable<Uint8Array>> {
  return {
    *[Symbol.iterator]() {
      const subscription = yield* stream

      const asyncIterable: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              const result = await run(function* () {
                return yield* subscription.next()
              })
              if (result.done) {
                return { done: true, value: undefined }
              }
              return { done: false, value: serialize(result.value) }
            },
          }
        },
      }

      return asyncIterable
    },
  }
}
