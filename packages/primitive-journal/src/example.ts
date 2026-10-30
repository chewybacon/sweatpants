import { driveJournal } from "./driver.ts";
import type { Journal, Json, RetryMode } from "./contract.ts";
import type { Handler, HandlerMiddleware, IterableOperation, Outcome, Work } from "./primitives.ts";

export type RecordRequest = { kind: "record"; key: string; retrySafety: { mode: RetryMode } };

/** Guest API: validates the untyped reply at the delegation boundary. */
export function* record(
  key: string,
  mode: RetryMode = "repeatable",
): IterableOperation<string, RecordRequest> {
  const value = yield { kind: "record", key, retrySafety: { mode } };
  if (typeof value !== "string") {
    throw new TypeError("Expected string reply");
  }
  return value;
}

export const sequence: Work<string, RecordRequest> = function* () {
  const first = yield* record("same");
  const second = yield* record("same");
  return `${first}|${second}:done`;
};

/** Application integration supplies storage and native I/O; the guest stays synchronous. */
export function createSequenceRunner<Y>(
  journal: Journal,
  handler: Handler<RecordRequest, Y, Outcome<Json, Json>>,
  middleware: readonly HandlerMiddleware<RecordRequest, Y, Outcome<Json, Json>>[] = [],
): Work<string, Y> {
  return () => driveJournal(sequence, journal, handler, middleware);
}
