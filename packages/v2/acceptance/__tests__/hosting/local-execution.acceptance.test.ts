import { expect, it, onTestFinished } from "vitest";
import { createHostedExecution } from "@sweatpan.ts/testing";
import { createScopedGuest, type Guest, type CheckpointAdapter } from "@sweatpan.ts/execution";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: local placement detaches snapshots and restores a fresh incarnation without starting over`, async () => {
    let acquired = 0;
    let restored = 0;
    let disposed = 0;
    const owned = new WeakMap<Guest<number, { count: number }, Y>, { count: number }>();
    const source = { count: 1 };
    function guest(state: { count: number }): Guest<number, { count: number }, Y> {
      const value: Guest<number, { count: number }, Y> = {
        *start() {
          return { kind: "suspended", request: state };
        },
        *resume() {
          return { kind: "completed", value: state.count };
        },
        *close() {
          disposed++;
        },
      };
      owned.set(value, state);
      return value;
    }
    const checkpoints: CheckpointAdapter<number, { count: number }, Y, unknown, unknown, unknown> =
      {
        format: "counter:v1",
        *capture(value) {
          return owned.get(value);
        },
        *restore(state) {
          if (
            !state ||
            typeof state !== "object" ||
            !("count" in state) ||
            typeof state.count !== "number"
          ) {
            throw new Error("Invalid counter snapshot");
          }
          restored++;
          const value = guest(state as { count: number });
          return { guest: value, turn: { kind: "suspended", request: state as { count: number } } };
        },
      };
    const local = createHostedExecution(runtime, {
      *acquire() {
        acquired++;
        return guest(source);
      },
      checkpoints,
    });
    const adapter = local.checkpoints!;
    const task = runtime.start(function* () {
      const first = yield* local.acquire();
      yield* runtime.composition.ensure(() => first.close());
      const turn = yield* first.start();
      expect(turn).toEqual({ kind: "suspended", request: { count: 1 } });
      expect(
        yield* adapter.capture(
          createScopedGuest(function* () {
            return 0;
          }),
        ),
      ).toBeUndefined();
      // Constructing an operation must not consume the protocol's next command sequence.
      adapter.capture(first);
      const state = (yield* adapter.capture(first)) as { count: number };
      expect(state).not.toBe(source);
      state.count = 7;
      expect(source.count).toBe(1);
      yield* first.close();
      const second = yield* adapter.restore(state);
      yield* runtime.composition.ensure(() => second.guest.close());
      expect(second.turn).toEqual({ kind: "suspended", request: { count: 7 } });
      state.count = 99;
      expect(yield* second.guest.resume({ ok: true, value: null })).toEqual({
        kind: "completed",
        value: 7,
      });
    });
    onTestFinished(() => task.cancel());
    await task.result;
    expect(acquired).toBe(1);
    expect(restored).toBe(1);
    expect(disposed).toBe(2);
  });

  it(`${runtime.name}: supported checkpoint restore failure propagates without acquiring a fresh Guest`, async () => {
    let acquired = 0;
    let attempted = 0;
    const local = createHostedExecution<number, string, Y>(runtime, {
      *acquire() {
        acquired++;
        return createScopedGuest(function* () {
          return 1;
        });
      },
      checkpoints: {
        format: "rejecting:v1",
        *capture() {
          return undefined;
        },
        *restore() {
          attempted++;
          throw new Error("Snapshot rejected");
        },
      },
    });
    const task = runtime.start(() => local.checkpoints!.restore({ invalid: true }));
    onTestFinished(() => task.cancel());
    await expect(task.result).rejects.toThrow("Snapshot rejected");
    expect(attempted).toBe(1);
    expect(acquired).toBe(0);
  });
});
