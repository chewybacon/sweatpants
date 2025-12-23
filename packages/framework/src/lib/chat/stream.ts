import type { Operation, Stream, Subscription } from 'effection'

/**
 * Consume a stream with an async handler, returning the stream's TReturn.
 */
export function* consumeAsync<T, R>(
  stream: Stream<T, R>,
  handler: (value: T) => Operation<void>
): Operation<R> {
  const subscription: Subscription<T, R> = yield* stream
  let next = yield* subscription.next()

  while (!next.done) {
    yield* handler(next.value)
    next = yield* subscription.next()
  }

  return next.value
}
