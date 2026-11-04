import type { Operation } from "@standard-durability/core";
import type { DurableObjectHost } from "./contracts.ts";
/**
 * Stop retrying an alarm after `maxRetries` Cloudflare retries. Earlier failures
 * still rethrow, so Cloudflare's own backoff applies. Exhausted failures go to
 * `onExhausted` (for example to record them) and the alarm ends. The journal is
 * unchanged; a later `wake()` can try again. Install inside `alarm(info, install)`.
 */
export function* installAlarmRetryLimit<R, Q, V, E, Frame, Result, Y>(
  host: DurableObjectHost<R, Q, V, E, Frame, Result, Y>,
  maxRetries: number,
  onExhausted?: (error: unknown) => Operation<void, Y>,
): Operation<void, Y> {
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error("maxRetries must be a nonnegative integer");
  }
  yield* host.around({
    operations: {
      settle: (next) =>
        function* (outcome, run) {
          if (!outcome.ok && run.invocation.retryCount >= maxRetries) {
            if (onExhausted) {
              yield* onExhausted(outcome.error);
            }
            return;
          }
          return yield* next(outcome, run);
        },
    },
  });
}
