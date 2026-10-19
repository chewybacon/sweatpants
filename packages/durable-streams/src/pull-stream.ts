import { resource } from "effection";
import type { Operation, Stream, Subscription } from "effection";

import type { TokenBuffer, TokenBufferWriter, TokenFrame } from "./types.ts";

const READ_BATCH_SIZE = 256;

export function createPullStream<T>(
  buffer: TokenBuffer<T>,
  startLSN = 0,
): Stream<TokenFrame<T>, void> {
  return resource(function* (provide) {
    let cursor = startLSN;
    let batch: (T | undefined)[] = [];
    let index = 0;
    let terminal: { error: Error | null } | undefined;

    yield* provide({
      *next(): Operation<IteratorResult<TokenFrame<T>, void>> {
        while (true) {
          if (index < batch.length) {
            const token = batch[index] as T;
            // Release consumed payloads even when the consumer stops mid-batch.
            batch[index++] = undefined;
            const lsn = cursor + 1;
            cursor = lsn;
            return { done: false, value: { token, lsn } };
          }

          const { tokens } = yield* buffer.read(cursor, READ_BATCH_SIZE);
          batch = tokens;
          index = 0;
          if (batch.length > 0) {
            continue;
          }

          if (terminal) {
            if (terminal.error) {
              throw terminal.error;
            }
            return { done: true, value: undefined };
          }

          const complete = yield* buffer.isComplete();
          const error = yield* buffer.getError();
          if (complete || error) {
            // A writer may append and close between the read and the status check.
            // Drain once more after observing the immutable terminal state.
            terminal = { error };
            continue;
          }

          yield* buffer.waitForChange(cursor);
        }
      },
    });
  });
}

export function* writeFromStreamToBuffer<T>(
  source: Stream<T, void>,
  writer: TokenBufferWriter<T>,
): Operation<void> {
  const subscription: Subscription<T, void> = yield* source;

  let result = yield* subscription.next();
  while (!result.done) {
    yield* writer.append([result.value]);
    result = yield* subscription.next();
  }

  yield* writer.complete();
}
