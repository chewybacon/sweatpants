import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import {
  createStreamApi,
  type Runtime,
  type Stream,
  type StreamApi,
  type Subscription,
} from "@sweatpan.ts/runtime";
import { forEachRuntime } from "./assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: stream API composes scoped sources, installed drivers and event middleware`, async () => {
    const source = runtime.composition.createContext<Stream<number, string, Y>>("events.source");
    const messages = createStreamApi(runtime.composition, "events", {
      *subscribe() {
        const selected = yield* source.expect();
        return yield* selected;
      },
    });
    expectTypeOf(messages).toEqualTypeOf<StreamApi<number, string, Y>>();
    const outer = runtime.createChannel<number, string>();
    const inner = runtime.createChannel<number, string>();
    const installed = runtime.createChannel<number, string>();
    const stream = messages.stream;
    let subscriptions = 0;
    const observed: number[] = [];
    let escaped: Subscription<number, string, Y> | undefined;
    const task = runtime.start(function* () {
      yield* source.set(outer);
      yield* messages.around({
        *subscribe(args, next) {
          subscriptions++;
          const subscription = yield* next(...args);
          return {
            *next() {
              const item = yield* subscription.next();
              if (item.done) {
                return item;
              }
              observed.push(item.value);
              return { done: false as const, value: item.value * 10 };
            },
          };
        },
      });
      const parent = yield* stream;
      yield* outer.send(1);
      expect(yield* parent.next()).toEqual({ done: false, value: 10 });
      yield* runtime.composition.scoped(function* () {
        yield* source.set(inner);
        const child = yield* stream;
        escaped = child;
        yield* inner.send(2);
        expect(yield* child.next()).toEqual({ done: false, value: 20 });
        // Selecting a new source does not retarget an existing parent subscription.
        yield* outer.send(3);
        expect(yield* parent.next()).toEqual({ done: false, value: 30 });
      });
      const rejected = yield* runtime.composition.catchError(
        () => escaped!.next(),
        function* (error) {
          return String(error);
        },
      );
      expect(rejected).toContain("Stream subscription scope exited");
      yield* runtime.composition.scoped(function* () {
        yield* messages.install({
          *subscribe() {
            return yield* installed;
          },
        });
        const replacement = yield* stream;
        yield* installed.send(4);
        expect(yield* replacement.next()).toEqual({ done: false, value: 40 });
      });
      // The captured facade resolves the outer driver/context again after child exit.
      const restored = yield* messages.operations.subscribe();
      yield* outer.send(5);
      expect(yield* restored.next()).toEqual({ done: false, value: 50 });
      expect(yield* parent.next()).toEqual({ done: false, value: 50 });
      yield* outer.close("finished");
      expect(yield* restored.next()).toEqual({ done: true, value: "finished" });
      expect(yield* parent.next()).toEqual({ done: true, value: "finished" });
    });
    onTestFinished(() => task.cancel());
    await task.result;
    expect(subscriptions).toBe(4);
    expect(observed).toEqual([1, 2, 3, 4, 5, 5]);
  });
});
