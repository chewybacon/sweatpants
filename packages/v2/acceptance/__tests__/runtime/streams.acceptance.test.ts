import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Work } from "@standard-durability/core";
import { createStreams } from "@sweatpan.ts/runtime";
import type { Runtime, Subscription, Stream } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "./assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task;
  }
  it(`${runtime.name}: callback arriving while entering a native wait is not lost`, async () => {
    let callback = () => {};
    const streams = createStreams({
      composition: runtime.composition,
      *fromPromise<T>(work: (signal: AbortSignal) => Promise<T>): Operation<T, Y> {
        yield* runtime.fromPromise(async () => {
          callback();
        });
        return yield* runtime.fromPromise(work);
      },
    });
    const signal = streams.createSignal<number>();
    callback = () => signal.send(42);
    const value = await start(function* () {
      const subscription = yield* signal;
      return yield* subscription.next();
    }).result;
    expect(value).toEqual({ done: false, value: 42 });
  });

  it(`${runtime.name}: callback signal broadcasts ordered events and removes its listener on scope exit`, async () => {
    const target = new EventTarget();
    const signal = runtime.createSignal<Event, string>();
    expectTypeOf(signal.send).returns.toEqualTypeOf<void>();
    const stream: Stream<Event, string, Y> = signal;
    signal.send(new Event("dropped"));
    let ready!: () => void;
    const subscribed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let removed = false;
    const task = start(function* () {
      const first = yield* stream;
      const second = yield* stream;
      target.addEventListener("event", signal.send);
      yield* runtime.composition.ensure(function* () {
        target.removeEventListener("event", signal.send);
        removed = true;
      });
      ready();
      const values: string[][] = [];
      for (const subscription of [first, second]) {
        const received: string[] = [];
        while (true) {
          const item = yield* subscription.next();
          if (item.done) {
            expect(item.value).toBe("finished");
            break;
          }
          received.push(item.value.type);
        }
        values.push(received);
      }
      return values;
    });
    await Promise.race([subscribed, task.result]);
    target.dispatchEvent(new Event("event"));
    target.dispatchEvent(new Event("event"));
    signal.close("finished");
    signal.send(new Event("after-close"));
    signal.close("ignored");
    expect(await task.result).toEqual([
      ["event", "event"],
      ["event", "event"],
    ]);
    expect(removed).toBe(true);
  });

  it(`${runtime.name}: channel publication is lazy and scoped subscriptions are independent`, async () => {
    await start(function* () {
      const channel = runtime.createChannel<number, string>();
      const publication = channel.send(1);
      expectTypeOf(publication).toEqualTypeOf<Operation<void, Y>>();
      const parent = yield* channel;
      const disposed = yield* runtime.composition.scoped(function* () {
        const child = yield* channel;
        yield* publication;
        expect(yield* child.next()).toEqual({ done: false, value: 1 });
        return child;
      });
      yield* channel.send(2);
      expect(yield* parent.next()).toEqual({ done: false, value: 1 });
      expect(yield* parent.next()).toEqual({ done: false, value: 2 });
      const error = yield* runtime.composition.catchError(
        () => disposed.next(),
        function* (error) {
          return String(error);
        },
      );
      expect(error).toContain("Stream subscription scope exited");
      yield* channel.close("done");
      expect(yield* parent.next()).toEqual({ done: true, value: "done" });
      expect(yield* parent.next()).toEqual({ done: true, value: "done" });
      // Like Effection, close completes existing subscriptions, not the producer forever.
      const later = yield* channel;
      yield* channel.send(3);
      yield* channel.close("later");
      expect(yield* later.next()).toEqual({ done: false, value: 3 });
      expect(yield* later.next()).toEqual({ done: true, value: "later" });
    }).result;
  });

  it(`${runtime.name}: cancelling a pending read does not consume the next event or unsubscribe its owner`, async () => {
    const signal = runtime.createSignal<string>();
    const stop = new AbortController();
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let recovered!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      recovered = resolve;
    });
    const task = start(function* () {
      const subscription = yield* signal;
      yield* runtime.composition.catchError(
        () =>
          runtime.withSignal(stop.signal, function* () {
            ready();
            return yield* subscription.next();
          }),
        function* () {
          recovered();
        },
      );
      return yield* subscription.next();
    });
    await Promise.race([waiting, task.result]);
    stop.abort(new Error("abandon this read"));
    await Promise.race([cancelled, task.result]);
    signal.send("next event");
    expect(await task.result).toEqual({ done: false, value: "next event" });
  });

  it(`${runtime.name}: cancelled subscriber releases callback resources without closing other consumers`, async () => {
    const signal = runtime.createSignal<number>();
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let leaked: Subscription<number, void, Y> | undefined;
    let finalized = false;
    const task = start(function* () {
      leaked = yield* signal;
      yield* runtime.composition.ensure(function* () {
        finalized = true;
      });
      ready();
      return yield* leaked.next();
    });
    await Promise.race([waiting, task.result]);
    await task.cancel();
    expect(finalized).toBe(true);
    await expect(start(() => leaked!.next()).result).rejects.toThrow(
      "Stream subscription scope exited",
    );
    signal.send(99);
    let nextReady!: () => void;
    const nextWaiting = new Promise<void>((resolve) => {
      nextReady = resolve;
    });
    const other = start(function* () {
      const subscription = yield* signal;
      nextReady();
      return yield* subscription.next();
    });
    await Promise.race([nextWaiting, other.result]);
    signal.send(7);
    expect(await other.result).toEqual({ done: false, value: 7 });
  });
});
