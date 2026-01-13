/**
 * Web Stream Bridge
 *
 * Bridges Effection-based TokenBuffers to Web ReadableStreams,
 * enabling use with standard HTTP Response objects.
 *
 * The challenge:
 * - Effection uses generator-based Operations with `yield*`
 * - Web Streams use `pull(controller)` async callbacks
 *
 * The solution:
 * - Use scope.run() inside pull() to execute Effection operations
 * - The scope is captured from the calling context
 */
import type { Scope, Subscription } from 'effection'
import type { TokenBuffer, TokenFrame } from './types.ts'
import { createPullStream } from './pull-stream.ts'

/**
 * Creates a Web ReadableStream from a TokenBuffer.
 *
 * The stream outputs NDJSON (newline-delimited JSON) where each line
 * is a TokenFrame: `{"token": "...", "lsn": 1}\n`
 *
 * @param scope - Effection scope for running operations in pull callbacks
 * @param buffer - TokenBuffer to read from
 * @param startLSN - Starting position (default 0, or last known LSN for reconnect)
 * @returns Web ReadableStream<Uint8Array>
 *
 * @example
 * ```typescript
 * const scope = yield* useScope()
 * const webStream = createWebStreamFromBuffer(scope, session.buffer)
 * const response = new Response(webStream, {
 *   headers: { 'content-type': 'application/x-ndjson' }
 * })
 * ```
 */
export function createWebStreamFromBuffer(
  scope: Scope,
  buffer: TokenBuffer<string>,
  startLSN = 0
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let subscription: Subscription<TokenFrame<string>, void> | null = null
  let initialized = false

  return new ReadableStream<Uint8Array>({
    async start() {
      // Initialize the pull stream subscription
      await scope.run(function* () {
        subscription = yield* createPullStream(buffer, startLSN)
        initialized = true
      })
    },

    async pull(controller) {
      if (!initialized || !subscription) {
        controller.error(new Error('Stream not initialized'))
        return
      }

      try {
        // Run the Effection operation in the captured scope
        const result = await scope.run(function* () {
          return yield* subscription!.next()
        })

        if (result.done) {
          controller.close()
        } else {
          const frame = result.value as TokenFrame<string>
          const json = JSON.stringify(frame) + '\n'
          controller.enqueue(encoder.encode(json))
        }
      } catch (err) {
        controller.error(err)
      }
    },
  })
}
