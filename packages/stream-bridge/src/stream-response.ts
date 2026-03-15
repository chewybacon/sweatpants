/**
 * Stream Response
 *
 * Creates a Response with a ReadableStream body that pulls from an Effection stream.
 * This is the recommended way to bridge Effection streams to HTTP responses.
 *
 * Implementation notes:
 * - Subscription is captured in start() before pull() is called
 * - No "initialized" flag needed - start() completes first
 * - Minimal pull() logic for best performance
 * - Proper cancellation handling with closed flag
 */
import { createScope, type Operation, type Scope, type Stream, type Subscription } from 'effection'

export interface StreamResponseOptions<T> {
  /** Serialize each value to Uint8Array. Defaults to NDJSON. */
  serialize?: (value: T) => Uint8Array
  /** Content-Type header. Defaults to 'application/x-ndjson' */
  contentType?: string
}

export interface StreamResponseResult {
  /** The Response with streaming body */
  response: Response
  /** The scope - caller must destroy when done */
  scope: Scope
  /** Destroy the scope and cleanup resources */
  destroy: () => Promise<void>
}

/**
 * Creates a Response with a ReadableStream body that pulls from an Effection stream.
 *
 * The stream is pull-based: values are only produced when the HTTP client
 * requests them (via read() on the response body).
 *
 * @param stream - The Effection stream to read from
 * @param options - Serialization and content-type options
 * @returns Operation that yields { response, scope, destroy }
 *
 * @example
 * ```typescript
 * const { response, destroy } = yield* createStreamResponse(myStream)
 *
 * // Use response in HTTP handler
 * return response
 *
 * // Later, when done:
 * await destroy()
 * ```
 */
export function createStreamResponse<T>(
  stream: Stream<T, void>,
  options: StreamResponseOptions<T> = {}
): Operation<StreamResponseResult> {
  const serialize = options.serialize ?? defaultSerialize
  const contentType = options.contentType ?? 'application/x-ndjson'

  const [scope, destroy] = createScope()
  let subscription: Subscription<T, void> | null = null
  let closed = false

  const readableStream = new ReadableStream<Uint8Array>({
    async start() {
      subscription = await scope.run(function* () {
        return yield* stream
      })
    },

    async pull(controller) {
      if (!subscription || closed) {
        controller.close()
        return
      }

      try {
        const result = await scope.run(function* () {
          return yield* subscription!.next()
        })

        if (result.done) {
          controller.close()
          closed = true
        } else {
          controller.enqueue(serialize(result.value))
        }
      } catch (err) {
        controller.error(err)
        closed = true
      }
    },

    cancel() {
      closed = true
    },
  })

  const response = new Response(readableStream, {
    headers: { 'Content-Type': contentType },
  })

  return {
    *[Symbol.iterator]() {
      return { response, scope, destroy }
    },
  }
}

/**
 * Creates a ReadableStream from an Effection stream with an existing scope.
 *
 * Use this when you already have a scope from the calling context.
 *
 * @param scope - Existing Effection scope
 * @param stream - The Effection stream to read from
 * @param options - Serialization options
 * @returns ReadableStream<Uint8Array>
 *
 * @example
 * ```typescript
 * const scope = yield* useScope()
 * const readableStream = createReadableStream(scope, myStream)
 * const response = new Response(readableStream)
 * ```
 */
export function createReadableStream<T>(
  scope: Scope,
  stream: Stream<T, void>,
  options: StreamResponseOptions<T> = {}
): ReadableStream<Uint8Array> {
  const serialize = options.serialize ?? defaultSerialize

  let subscription: Subscription<T, void> | null = null
  let closed = false

  return new ReadableStream<Uint8Array>({
    async start() {
      subscription = await scope.run(function* () {
        return yield* stream
      })
    },

    async pull(controller) {
      if (!subscription || closed) {
        controller.close()
        return
      }

      try {
        const result = await scope.run(function* () {
          return yield* subscription!.next()
        })

        if (result.done) {
          controller.close()
          closed = true
        } else {
          controller.enqueue(serialize(result.value))
        }
      } catch (err) {
        controller.error(err)
        closed = true
      }
    },

    cancel() {
      closed = true
    },
  })
}

function defaultSerialize<T>(value: T): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value) + '\n')
}
