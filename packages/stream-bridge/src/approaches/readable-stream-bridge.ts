/**
 * Approach 1: ReadableStream Bridge (Baseline)
 *
 * This is the current approach used in the framework. It creates a Web
 * ReadableStream and uses scope.run() inside the pull() callback to
 * execute Effection operations.
 *
 * Pros:
 * - Works with standard Response objects
 * - Backpressure handled by ReadableStream
 *
 * Cons:
 * - scope.run() overhead on every pull
 * - Mixing Effection and callback-based APIs
 */
import { createScope, type Operation, type Scope, type Stream, type Subscription } from 'effection'

export interface ReadableStreamBridgeOptions {
  /** Serialize each value to Uint8Array */
  serialize?: (value: unknown) => Uint8Array
}

/**
 * Creates a Response with a ReadableStream body that pulls from an Effection stream.
 *
 * Each pull() call runs scope.run() to get the next value from the subscription.
 */
export function createReadableStreamBridge<T>(
  stream: Stream<T, void>,
  options: ReadableStreamBridgeOptions = {}
): Operation<Response> {
  const serialize = options.serialize ?? ((v) => new TextEncoder().encode(JSON.stringify(v) + '\n'))

  const [scope, destroy] = createScope()

  let subscription: Subscription<T, void> | null = null
  let initialized = false
  let closed = false

  const readableStream = new ReadableStream<Uint8Array>({
    async start() {
      await scope.run(function* () {
        subscription = yield* stream
        initialized = true
      })
    },

    async pull(controller) {
      if (!initialized || !subscription || closed) {
        controller.close()
        return
      }

      try {
        const sub = subscription
        const result = await scope.run(function* () {
          return yield* sub.next()
        })

        if (result.done) {
          controller.close()
          closed = true
          await destroy()
        } else {
          controller.enqueue(serialize(result.value))
        }
      } catch (err) {
        controller.error(err)
        await destroy()
      }
    },

    async cancel() {
      closed = true
      await destroy()
    },
  })

  return {
    *[Symbol.iterator]() {
      return new Response(readableStream, {
        headers: { 'Content-Type': 'application/x-ndjson' },
      })
    },
  }
}

/**
 * Creates a ReadableStream from an Effection stream with an existing scope.
 * Useful when you already have a scope from the calling context.
 */
export function createReadableStreamFromScope<T>(
  scope: Scope,
  stream: Stream<T, void>,
  options: ReadableStreamBridgeOptions = {}
): ReadableStream<Uint8Array> {
  const serialize = options.serialize ?? ((v) => new TextEncoder().encode(JSON.stringify(v) + '\n'))

  let subscription: Subscription<T, void> | null = null
  let initialized = false
  let closed = false

  return new ReadableStream<Uint8Array>({
    async start() {
      await scope.run(function* () {
        subscription = yield* stream
        initialized = true
      })
    },

    async pull(controller) {
      if (!initialized || !subscription || closed) {
        controller.close()
        return
      }

      try {
        const sub = subscription
        const result = await scope.run(function* () {
          return yield* sub.next()
        })

        if (result.done) {
          controller.close()
          closed = true
        } else {
          controller.enqueue(serialize(result.value))
        }
      } catch (err) {
        controller.error(err)
      }
    },

    cancel() {
      closed = true
    },
  })
}
