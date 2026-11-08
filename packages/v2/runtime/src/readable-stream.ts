import type { Runtime, RuntimeExecution, Stream } from "./contracts.ts";

/**
 * Bridge a runtime Stream to a lazy web ReadableStream (highWaterMark 0). Nothing is
 * subscribed until the first read; each pull() performs exactly one subscription
 * next() inside one runtime-owned execution, so the consumer's read rate is the only
 * demand. Pair with BufferedSignal.from(offset, compact) to merge values produced
 * between reads. Completion closes the web stream (the close value is discarded);
 * failure errors it. cancel() halts the execution through native unwinding and
 * resolves only after cleanup joins. This is physical delivery, not durable acceptance.
 *
 * @example
 * ```ts
 * return new Response(createReadableStream(runtime, buffer.from(offset, merge)));
 * ```
 */
export function createReadableStream<T, Close, Y>(
  runtime: Runtime<Y>,
  stream: Stream<T, Close, Y>,
): ReadableStream<T> {
  let execution: RuntimeExecution<void> | undefined;
  let demand: (() => void) | undefined;
  let delivered: { resolve: () => void; reject: (error: unknown) => void } | undefined;
  let cancelled = false;
  function wait() {
    return new Promise<void>((resolve) => {
      demand = resolve;
    });
  }
  let pending = wait();
  return new ReadableStream<T>(
    {
      start(controller) {
        execution = runtime.start(function* () {
          yield* runtime.fromPromise(() => pending);
          const subscription = yield* stream;
          while (true) {
            const item = yield* subscription.next();
            const settle = delivered!;
            delivered = undefined;
            if (item.done) {
              controller.close();
              settle.resolve();
              return;
            }
            pending = wait();
            controller.enqueue(item.value);
            settle.resolve();
            yield* runtime.fromPromise(() => pending);
          }
        });
        execution.result.catch((error: unknown) => {
          const settle = delivered;
          delivered = undefined;
          if (!cancelled) {
            controller.error(error);
          }
          settle?.reject(error);
        });
      },
      pull() {
        return new Promise<void>((resolve, reject) => {
          delivered = { resolve, reject };
          demand?.();
        });
      },
      async cancel() {
        cancelled = true;
        await execution?.cancel();
      },
    },
    { highWaterMark: 0 },
  );
}
