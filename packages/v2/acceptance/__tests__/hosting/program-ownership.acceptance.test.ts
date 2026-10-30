import { expect, it, onTestFinished } from "vitest";
import {
  createProgramExecution,
  createScopedGuest,
  type Guest,
  type ResolvedProgram,
} from "@sweatpan.ts/execution";
import type { Operation } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: successive resolutions preserve each Guest's capture adapter and exclude unowned Guests`, async () => {
    let resolutions = 0;
    const captures: number[] = [];
    const execution = createProgramExecution({
      invocation: { program: "owned-capture", input: null },
      checkpointFormat: "counter:v1",
      *resolve(
        invocation,
      ): Operation<ResolvedProgram<number, string, Y, unknown, unknown, number>, Y> {
        const id = ++resolutions;
        let current: Guest<number, string, Y> | undefined;
        function create() {
          return createScopedGuest(function* () {
            yield "ready";
            return id;
          });
        }
        return {
          program: invocation.program,
          *acquire() {
            current = create();
            return current;
          },
          // A fresh replay-only evaluator is valid even with capture policy installed.
          checkpoints:
            id === 3
              ? undefined
              : {
                  format: "counter:v1",
                  *capture(guest) {
                    expect(guest).toBe(current);
                    captures.push(id);
                    return id;
                  },
                  *restore() {
                    current = create();
                    const turn = yield* current.start();
                    return { guest: current, turn };
                  },
                },
        };
      },
    });
    const task = runtime.start(function* () {
      const adapter = execution.checkpoints!;
      const first = yield* execution.acquire();
      yield* runtime.composition.ensure(() => first.close());
      const second = yield* execution.acquire();
      yield* runtime.composition.ensure(() => second.close());
      yield* first.start();
      yield* second.start();
      expect(yield* adapter.capture(first)).toBe(1);
      expect(yield* adapter.capture(second)).toBe(2);
      const unsupported = yield* execution.acquire();
      yield* runtime.composition.ensure(() => unsupported.close());
      yield* unsupported.start();
      expect(yield* adapter.capture(unsupported)).toBeUndefined();
      const foreign = createScopedGuest(function* () {
        return 99;
      });
      yield* runtime.composition.ensure(() => foreign.close());
      expect(yield* adapter.capture(foreign)).toBeUndefined();
      expect(resolutions).toBe(3);
      const restored = yield* adapter.restore(1);
      yield* runtime.composition.ensure(() => restored.guest.close());
      // A subsequent resolution must not replace either the original or restored adapter.
      const last = yield* execution.acquire();
      yield* runtime.composition.ensure(() => last.close());
      expect(yield* adapter.capture(restored.guest)).toBe(4);
      expect(yield* adapter.capture(first)).toBe(1);
      expect(yield* adapter.capture(second)).toBe(2);
      expect(resolutions).toBe(5);
    });
    onTestFinished(() => task.cancel());
    await task.result;
    expect(captures).toEqual([1, 2, 4, 1, 2]);
  });
});
