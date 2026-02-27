import { resource } from 'effection'
import type { Operation, Stream, Subscription } from 'effection'

import type { TokenBuffer, TokenFrame } from './types.ts'

export function createPullStream<T>(
  buffer: TokenBuffer<T>,
  startLSN = 0
): Stream<TokenFrame<T>, void> {
  return resource(function* (provide) {
    let cursor = startLSN

    yield* provide({
      *next(): Operation<IteratorResult<TokenFrame<T>, void>> {
        while (true) {
          const { tokens } = yield* buffer.read(cursor)

          if (tokens.length > 0) {
            const lsn = cursor + 1
            cursor = lsn
            return { done: false, value: { token: tokens[0]!, lsn } }
          }

          const complete = yield* buffer.isComplete()
          const error = yield* buffer.getError()

          if (error) {
            throw error
          }

          if (complete) {
            return { done: true, value: undefined }
          }

          yield* buffer.waitForChange(cursor)
        }
      },
    })
  })
}

export function* writeFromStreamToBuffer<T>(
  source: Stream<T, void>,
  buffer: TokenBuffer<T>
): Operation<void> {
  const subscription: Subscription<T, void> = yield* source

  let result = yield* subscription.next()
  while (!result.done) {
    yield* buffer.append([result.value])
    result = yield* subscription.next()
  }

  yield* buffer.complete()
}
