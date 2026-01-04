/**
 * Pull Stream Implementation
 *
 * Creates pull-based streams for reading from TokenBuffers.
 * Each reader gets an independent cursor, allowing multiple clients
 * to read from the same buffer at their own pace.
 */
import { resource } from 'effection'
import type { Operation, Stream, Subscription } from 'effection'
import type { TokenBuffer, TokenFrame } from './types'
import { useLogger } from '../../logger'

/**
 * Creates a pull-based stream from a TokenBuffer.
 *
 * Returns a Stream that yields TokenFrames (token + LSN) as they
 * become available. The stream blocks when no new tokens are available
 * and resumes when the buffer signals a change.
 *
 * Features:
 * - Independent cursor per stream (multiple readers supported)
 * - Backpressure via pull-based iteration
 * - LSN tracking for reconnect support
 * - Error propagation from buffer
 *
 * @param buffer - The TokenBuffer to read from
 * @param startLSN - Starting position (0 = beginning, or last known LSN for reconnect)
 * @returns Stream of TokenFrames
 *
 * @example
 * ```typescript
 * const stream = createPullStream(buffer, 0)
 * const subscription = yield* stream
 *
 * let result = yield* subscription.next()
 * while (!result.done) {
 *   console.log(result.value.token, result.value.lsn)
 *   result = yield* subscription.next()
 * }
 * ```
 */
export function createPullStream<T>(
  buffer: TokenBuffer<T>,
  startLSN = 0
): Stream<TokenFrame<T>, void> {
  return resource(function* (provide) {
    console.log('[pull-stream] resource started, getting logger')
    const log = yield* useLogger('durable-streams:pull')
    let cursor = startLSN
    console.log('[pull-stream] initialized, cursor:', cursor)
    log.debug({ bufferId: buffer.id, startLSN }, 'pull stream created')

    yield* provide({
      *next(): Operation<IteratorResult<TokenFrame<T>, void>> {
        console.log('[pull-stream] next() called, cursor:', cursor)
        while (true) {
          console.log('[pull-stream] reading buffer at cursor:', cursor)
          const { tokens } = yield* buffer.read(cursor)
          console.log('[pull-stream] read result: tokens.length =', tokens.length)

          if (tokens.length > 0) {
            // Return token with LSN, advance cursor
            const lsn = cursor + 1
            cursor = lsn
            console.log('[pull-stream] returning token at lsn:', lsn)
            log.debug({ bufferId: buffer.id, lsn }, 'pull stream read token')
            return { done: false, value: { token: tokens[0]!, lsn } }
          }

          // Check if stream is done
          const complete = yield* buffer.isComplete()
          const error = yield* buffer.getError()
          console.log('[pull-stream] complete:', complete, 'error:', !!error)

          if (error) {
            log.debug({ bufferId: buffer.id, error: error.message }, 'pull stream error')
            throw error
          }

          if (complete) {
            console.log('[pull-stream] returning done')
            log.debug({ bufferId: buffer.id, cursor }, 'pull stream complete')
            return { done: true, value: undefined }
          }

          // Wait for more data
          console.log('[pull-stream] waiting for change at cursor:', cursor)
          log.debug({ bufferId: buffer.id, cursor }, 'pull stream waiting for change')
          yield* buffer.waitForChange(cursor)
          console.log('[pull-stream] change signaled')
          log.debug({ bufferId: buffer.id, cursor }, 'pull stream change signaled')
        }
      },
    })
  })
}

/**
 * Helper to write from a source stream to a buffer.
 *
 * This is the common pattern for the "writer" side that connects
 * an LLM stream to a TokenBuffer.
 *
 * @param source - Source stream (e.g., LLM token stream)
 * @param buffer - Target TokenBuffer to write to
 *
 * @example
 * ```typescript
 * yield* spawn(function* () {
 *   try {
 *     yield* writeFromStreamToBuffer(llmStream, buffer)
 *   } catch (err) {
 *     yield* buffer.fail(err)
 *   }
 * })
 * ```
 */
export function* writeFromStreamToBuffer<T>(
  source: Stream<T, void>,
  buffer: TokenBuffer<T>
): Operation<void> {
  console.log('[writeFromStreamToBuffer] starting')
  const log = yield* useLogger('durable-streams:writer')
  log.debug({ bufferId: buffer.id }, 'writeFromStreamToBuffer started')
  
  console.log('[writeFromStreamToBuffer] acquiring source subscription')
  const subscription: Subscription<T, void> = yield* source
  console.log('[writeFromStreamToBuffer] source subscription acquired')
  log.debug({ bufferId: buffer.id }, 'source subscription acquired')
  
  let tokenCount = 0
  console.log('[writeFromStreamToBuffer] calling first subscription.next()')
  let result = yield* subscription.next()
  console.log('[writeFromStreamToBuffer] first result done:', result.done)
  while (!result.done) {
    yield* buffer.append([result.value])
    tokenCount++
    if (tokenCount === 1 || tokenCount % 50 === 0) {
      console.log('[writeFromStreamToBuffer] appended token', tokenCount)
      log.debug({ bufferId: buffer.id, tokenCount }, 'writeFromStreamToBuffer progress')
    }
    result = yield* subscription.next()
  }
  yield* buffer.complete()
  console.log('[writeFromStreamToBuffer] complete, total tokens:', tokenCount)
  log.debug({ bufferId: buffer.id, totalTokens: tokenCount }, 'writeFromStreamToBuffer complete')
}
