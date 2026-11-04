import {
  createBufferedSignal,
  createReadableStream,
  type BufferedSignal,
} from "@sweatpan.ts/runtime";
import {
  createDurableObjectSqliteConnection,
  createSqliteJournalStore,
} from "@sweatpan.ts/storage-sqlite";
import { createDurableObjectHostApi } from "./apis.ts";
import type { AlarmOutcome, DurableObjectHost, DurableObjectHostOptions } from "./contracts.ts";

/**
 * Host one journal tree inside a Durable Object. Commands write through `journal()`,
 * then call `wake()`; the object's alarm advances the program with no client attached.
 * Readers use `events()` for provisional frames and the journal for accepted state.
 * Frames are lost on eviction; the alarm and journal are not.
 *
 * @example
 * ```ts
 * export class Conversation extends DurableObject {
 *   host = createDurableObjectHost({ runtime, storage: this.ctx.storage, ... });
 *   alarm() { return this.host.alarm(); }
 * }
 * ```
 */
export function createDurableObjectHost<R, Q, V, E, Frame, Result, Y>(
  options: DurableObjectHostOptions<R, Q, V, E, Frame, Result, Y>,
): DurableObjectHost<R, Q, V, E, Frame, Result, Y> {
  const { runtime, storage, serializer } = options;
  const store = createSqliteJournalStore<R, Q, V, E, unknown, Y>({
    connection: createDurableObjectSqliteConnection(storage),
    id: options.id ?? "root",
    program: options.program,
    equals: options.equals,
    revocations: options.revocations,
    serialization: {
      *resolve() {
        return serializer;
      },
    },
  });
  const api = createDurableObjectHostApi(runtime.composition, options.advance);
  let frames: BufferedSignal<Frame, Result, Y> | undefined;
  let pending: BufferedSignal<Frame, Result, Y> | undefined;
  const host: DurableObjectHost<R, Q, V, E, Frame, Result, Y> = {
    ...api,
    journal: () => store.open(),
    async wake() {
      // Wakes before dispatch share one buffer, including already attached readers.
      frames = pending ??= createBufferedSignal<Frame, Result, Y>(runtime);
      await storage.setAlarm(Date.now());
    },
    async alarm(invocation = { retryCount: 0, isRetry: false }, install) {
      // Consume the pending buffer once. Retries must not reuse a terminal stream.
      const current = pending ?? createBufferedSignal<Frame, Result, Y>(runtime);
      pending = undefined;
      frames = current;
      await runtime.start(function* () {
        if (install) {
          yield* install(host);
        }
        const run = {
          journal: store.open(),
          emit: (frame: Frame) => current.send(frame),
          invocation,
        };
        const outcome = yield* runtime.composition.catchError(
          function* (): Generator<Y, AlarmOutcome<Result>, any> {
            return { ok: true, value: yield* api.operations.advance(run) };
          },
          function* (error): Generator<never, AlarmOutcome<Result>, any> {
            return { ok: false, error };
          },
        );
        if (outcome.ok) {
          current.close(outcome.value);
        } else {
          current.fail(outcome.error);
        }
        yield* api.operations.settle(outcome, run);
      }).result;
    },
    events(offset = 0, compact) {
      const current = frames;
      return current && createReadableStream(runtime, current.from(offset, compact));
    },
  };
  return host;
}
