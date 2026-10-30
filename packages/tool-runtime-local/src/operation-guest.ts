import { action, call, resource, useScope, type Operation, type Task } from "effection";
import type { Guest, Handler, Outcome, Turn } from "@sweatpants/foundation/computation";

type NativeYield = Operation<unknown> extends Iterable<infer Y> ? Y : never;

/** Adapt native structured computation to explicit Guest turns. No work starts at acquisition. */
export function createOperationGuest<T, Request, Value>(
  work: (request: Handler<Request, NativeYield, Value>) => Operation<T>,
): Operation<Guest<T, Request, NativeYield, Value>> {
  return resource(function* (provide) {
    // The resource scope owns the computation across calls from different turn scopes.
    const owner = yield* useScope();
    let task: Task<void> | undefined;
    let state: "new" | "running" | "suspended" | "completed" | "failed" | "closed" = "new";
    let deliver: ((turn: Turn<T, Request>) => void) | undefined;
    let fail: ((error: unknown) => void) | undefined;
    let answer: ((outcome: Outcome<Value, unknown>) => void) | undefined;

    function wait(advance: () => void): Promise<Turn<T, Request>> {
      return new Promise((resolve, reject) => {
        deliver = resolve;
        fail = reject;
        advance();
      });
    }
    function publish(turn: Turn<T, Request>) {
      const resolve = deliver;
      deliver = undefined;
      fail = undefined;
      resolve?.(turn);
    }
    const request: Handler<Request, NativeYield, Value> = function* (value) {
      const outcome = yield* action<Outcome<Value, unknown>>((resolve) => {
        answer = resolve;
        state = "suspended";
        publish({ kind: "suspended", request: value });
        return () => {
          answer = undefined;
        };
      });
      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.value;
    };
    function* close(): Operation<void> {
      state = "closed";
      fail?.(new Error("Guest closed"));
      deliver = undefined;
      fail = undefined;
      answer = undefined;
      if (task) {
        yield* task.halt();
      }
    }
    try {
      yield* provide({
        *start() {
          if (state !== "new") {
            throw new Error("Guest already started");
          }
          state = "running";
          return yield* call(() =>
            wait(() => {
              task = owner.run(function* () {
                try {
                  const value = yield* work(request);
                  state = "completed";
                  publish({ kind: "completed", value });
                } catch (error) {
                  state = "failed";
                  fail?.(error);
                  deliver = undefined;
                  fail = undefined;
                }
              });
            }),
          );
        },
        *resume(outcome) {
          if (state !== "suspended" || !answer) {
            throw new Error("Guest is not suspended");
          }
          const resume = answer;
          answer = undefined;
          state = "running";
          return yield* call(() => wait(() => resume(outcome)));
        },
        close,
      });
    } finally {
      yield* close();
    }
  });
}
