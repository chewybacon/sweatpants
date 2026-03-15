/**
 * Approach 3: Scope-Captured Stream
 *
 * Pre-captures the subscription during setup, minimizing scope.run() calls.
 * The subscription is obtained once, then only next() needs scope.run().
 *
 * Pros:
 * - Fewer scope.run() calls (only for next(), not for stream subscription)
 * - Cleaner separation of setup and iteration
 *
 * Cons:
 * - Still needs scope.run() for each next()
 * - More complex state management
 */
import { createScope, type Operation, type Scope, type Stream, type Subscription } from 'effection'

export interface ScopeCapturedStreamOptions {
  /** Serialize each value to Uint8Array */
  serialize?: (value: unknown) => Uint8Array
}

export interface ScopeCapturedResult {
  /** The Response with streaming body */
  response: Response
  /** The scope - caller must destroy when done */
  scope: Scope
  /** Destroy the scope */
  destroy: () => Promise<void>
}

/**
 * Creates a Response where the subscription is captured during setup.
 *
 * This approach separates the concerns:
 * 1. Setup phase: Create scope, get subscription
 * 2. Streaming phase: Only scope.run(subscription.next) per pull
 */
export function createScopeCapturedStream<T>(
  stream: Stream<T, void>,
  options: ScopeCapturedStreamOptions = {}
): Operation<ScopeCapturedResult> {
  const serialize = options.serialize ?? ((v) => new TextEncoder().encode(JSON.stringify(v) + '\n'))

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

    async cancel() {
      closed = true
      await destroy()
    },
  })

  const response = new Response(readableStream, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  })

  return {
    *[Symbol.iterator]() {
      return { response, scope, destroy }
    },
  }
}

/**
 * Alternative: Create an async iterable with pre-captured subscription.
 *
 * This is the most minimal approach - just wraps the subscription
 * in an async iterable interface.
 */
export function createCapturedAsyncIterable<T>(
  scope: Scope,
  subscription: Subscription<T, void>,
  serialize: (value: T) => Uint8Array,
): AsyncIterable<Uint8Array> {
  let closed = false

  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (closed) {
            return { done: true, value: undefined }
          }

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
