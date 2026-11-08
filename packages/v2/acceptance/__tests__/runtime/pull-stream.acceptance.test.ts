import { expect, it, onTestFinished } from "vitest";
import {
  createPullStream,
  createStreamApi,
  type Runtime,
  type Subscription,
} from "@sweatpan.ts/runtime";
import { createProtocolRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "./assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: scoped pull production advances only on demand and retains terminal results`, async () => {
    let pulls = 0;
    let escaped: Subscription<string, number, Y>;
    const task = runtime.start(function* () {
      yield* runtime.composition.scoped(function* () {
        const source = createPullStream<string, number, never, Y>(
          runtime.composition,
          () =>
            function* () {
              pulls++;
              return pulls === 1
                ? { done: false as const, value: "first" }
                : { done: true as const, value: 42 };
            },
        );
        const api = createStreamApi(runtime.composition, "pull", {
          *subscribe() {
            return yield* source;
          },
        });
        const reader = yield* api.stream;
        escaped = reader;
        expect(pulls).toBe(0);
        expect(yield* reader.next()).toEqual({ done: false, value: "first" });
        expect(pulls).toBe(1);
        const duplicate = yield* runtime.composition.catchError(
          () => api.stream,
          function* (error) {
            return String(error);
          },
        );
        expect(duplicate).toContain("already acquired");
        expect(yield* reader.next()).toEqual({ done: true, value: 42 });
        expect(yield* reader.next()).toEqual({ done: true, value: 42 });
        expect(pulls).toBe(2);
      });
      const disposed = yield* runtime.composition.catchError(
        () => escaped!.next(),
        function* (error) {
          return String(error);
        },
      );
      expect(disposed).toContain("scope exited");
    });
    onTestFinished(() => task.cancel());
    await task.result;
  });

  it(`${runtime.name}: cancelling an in-flight pull joins its owner and invalidates the escaped reader`, async () => {
    const peer = createProtocolRig();
    let escaped: Subscription<string, void, Y>;
    const task = runtime.start(function* () {
      const source = createPullStream<string, void, Y, Y>(
        runtime.composition,
        () =>
          function* () {
            const response = yield* runtime.fromPromise((signal) =>
              peer.send({ id: "pull", token: "next" }, signal),
            );
            return { done: false, value: response.body };
          },
      );
      escaped = yield* source;
      yield* escaped.next();
    });
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    await Promise.race([peer.waitForRequests(1), task.result]);
    // A second driver must not consume work while the first pull is suspended.
    const concurrent = runtime.start(() => escaped!.next());
    onTestFinished(() => concurrent.cancel());
    await expect(concurrent.result).rejects.toThrow("Concurrent");
    await task.cancel();
    const stale = runtime.start(() => escaped!.next());
    onTestFinished(() => stale.cancel());
    await expect(stale.result).rejects.toThrow("scope exited");
    expect(peer.requests).toHaveLength(1);
  });
});
