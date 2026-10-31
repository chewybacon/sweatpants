import { createBufferedSignal, type Runtime } from "@sweatpan.ts/runtime";
import type { HostedActivation, HostedActivationOptions } from "./contracts.ts";

/**
 * Start one eager, application-owned activation independently of its readers.
 * Configure scoped capabilities inside run: runtime.start creates a new native root.
 * The caller owns cancellation. Disconnecting a reader never cancels this execution.
 * Retained output is unbounded, in-memory and held by reference, not a durable log.
 */
export function createHostedActivation<Frame, Result, Y>(
  runtime: Runtime<Y>,
  options: HostedActivationOptions<Frame, Result, Y>,
): HostedActivation<Frame, Result, Y> {
  const output = createBufferedSignal<Frame, Result, Y>(runtime);
  const execution = runtime.start(() => options.run(output.send));
  const result = execution.result
    .then((value) => {
      // Runtime completion is a joined cleanup barrier, including on park.
      const frames = options.present?.(value) ?? [];
      for (const frame of frames) {
        output.send(frame);
      }
      output.close(value);
      return value;
    })
    .catch((error: unknown) => {
      output.fail(error);
      throw error;
    });
  // Readers may be the only observers of failure. Keep result rejecting for explicit callers.
  void result.catch(() => undefined);
  return {
    result,
    from: output.from,
    async cancel() {
      await execution.cancel();
      await result.catch(() => undefined);
    },
  };
}
