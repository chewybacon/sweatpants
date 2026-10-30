import { createLocalTransport } from "@sweatpan.ts/connection";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { LocalExecution, LocalExecutionOptions, WorkerGuestOptions } from "./contracts.ts";
import type { Operation } from "@standard-durability/core";
import { createWorkerExecution } from "./execution.ts";
import { serveGuestWorker } from "./serve.ts";

/** Local placement preserves the real serialized boundary; assembly supplies its value codec. */
export function createLocalExecution<R, Q, Y, V = unknown, E = unknown>(
  runtime: Runtime<Y>,
  options: LocalExecutionOptions<R, Q, Y, V, E>,
): LocalExecution<R, Q, Y, V, E> {
  let sequence = 0;
  function* open(): Operation<WorkerGuestOptions, Y> {
    const [port1, port2] = createLocalTransport();
    const failure = new AbortController();
    const incarnation = `local-${sequence++}`;
    const task = runtime.start(() =>
      serveGuestWorker(runtime, {
        incarnation,
        port: port2,
        codec: options.codec,
        acquire: options.acquire,
        checkpoints: options.checkpoints,
      }),
    );
    void task.result.catch((error) => failure.abort(error));
    let shutdown: Promise<void> | undefined;
    function terminate() {
      return (shutdown ??= (async () => {
        failure.abort(new Error("Local execution disposed"));
        port1.close();
        await task.cancel();
        port2.close();
      })());
    }
    yield* runtime.composition.ensure(() => runtime.fromPromise(terminate));
    return { incarnation, port: port1, codec: options.codec, failure: failure.signal, terminate };
  }
  return createWorkerExecution<R, Q, Y, V, E>(runtime, {
    open,
    checkpointFormat: options.checkpoints?.format,
  });
}
