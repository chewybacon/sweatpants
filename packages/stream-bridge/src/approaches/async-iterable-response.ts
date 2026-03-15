/**
 * Approach 2: AsyncIterable Response Body
 *
 * The Fetch API allows Response body to be an AsyncIterable<Uint8Array>.
 * This approach uses that directly, avoiding the ReadableStream boilerplate.
 *
 * Pros:
 * - Simpler code, no ReadableStream
 * - Native async iteration
 *
 * Cons:
 * - Still needs scope.run() for each iteration
 * - Less control over backpressure
 */
import { createScope, type Operation, type Scope, type Stream, type Subscription } from 'effection'

export interface AsyncIterableResponseOptions {
  /** Serialize each value to Uint8Array */
  serialize?: (value: unknown) => Uint8Array
  /** Content-Type header */
  contentType?: string
}

/**
 * Creates a Response with an AsyncIterable body.
 *
 * The body is an async iterable that pulls from the Effection stream.
 */
export function createAsyncIterableResponse<T>(
  stream: Stream<T, void>,
  options: AsyncIterableResponseOptions = {}
): Operation<Response> {
  const serialize = options.serialize ?? ((v) => new TextEncoder().encode(JSON.stringify(v) + '\n'))
  const contentType = options.contentType ?? 'application/x-ndjson'

  const [scope, destroy] = createScope()
  let subscription: Subscription<T, void> | null = null
  let closed = false

  const asyncIterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (closed) {
            return { done: true, value: undefined }
          }

          if (!subscription) {
            subscription = await scope.run(function* () {
              return yield* stream
            })
          }

          try {
            const result = await scope.run(function* () {
              return yield* subscription!.next()
            })

            if (result.done) {
              closed = true
              await destroy()
              return { done: true, value: undefined }
            }

            return { done: false, value: serialize(result.value) }
          } catch (err) {
            closed = true
            await destroy()
            throw err
          }
        },

        async return() {
          closed = true
          await destroy()
          return { done: true, value: undefined }
        },
      }
    },
  }

  return {
    *[Symbol.iterator]() {
      return new Response(asyncIterable as unknown as BodyInit, {
        headers: { 'Content-Type': contentType },
      })
    },
  }
}

/**
 * Creates an AsyncIterable from an Effection stream with an existing scope.
 */
export function createAsyncIterableFromScope<T>(
  scope: Scope,
  stream: Stream<T, void>,
  options: AsyncIterableResponseOptions = {}
): AsyncIterable<Uint8Array> {
  const serialize = options.serialize ?? ((v) => new TextEncoder().encode(JSON.stringify(v) + '\n'))

  let closed = false

  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (closed) {
            return { done: true, value: undefined }
          }

          const subscription = await scope.run(function* () {
            return yield* stream
          })

          const result = await scope.run(function* () {
            return yield* subscription.next()
          })

          if (result.done) {
            closed = true
            return { done: true, value: undefined }
          }

          return { done: false, value: serialize(result.value) }
        },

        return() {
          closed = true
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
}
