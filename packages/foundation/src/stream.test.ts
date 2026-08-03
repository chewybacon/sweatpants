import {
  call,
  createQueue,
  resource,
  run,
  spawn,
  suspend,
  type Queue,
  type Stream,
} from "effection";
import { describe, expect, it } from "vitest";
import { createEagerBuffer } from "./stream.ts";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function streamFromQueue<T, TDone>(queue: Queue<T, TDone>): Stream<T, TDone> {
  return resource(function* (provide) {
    yield* provide({ next: () => queue.next() });
  });
}

function observeValues<T, TDone>(
  source: Stream<T, TDone>,
  onValue: (value: T) => void,
  onSettled?: () => void,
): Stream<T, TDone> {
  return resource(function* (provide) {
    const subscription = yield* source;
    yield* provide({
      *next() {
        try {
          const next = yield* subscription.next();
          if (next.done) {
            onSettled?.();
          } else {
            onValue(next.value);
          }
          return next;
        } catch (error) {
          onSettled?.();
          throw error;
        }
      },
    });
  });
}

describe("createEagerBuffer", () => {
  it("returns an empty batch immediately when nothing has arrived", async () => {
    await run(function* () {
      const source = createQueue<number, void>();
      const buffer = yield* createEagerBuffer(streamFromQueue(source));
      expect(buffer.drain()).toEqual([]);
      expect(buffer.state).toEqual({ status: "open" });
    });
  });

  it("eagerly collects source values before the downstream drain", async () => {
    await run(function* () {
      const source = createQueue<number, void>();
      const collected = deferred();
      let count = 0;
      const observed = observeValues(streamFromQueue(source), () => {
        count += 1;
        if (count === 3) {
          collected.resolve();
        }
      });
      const buffer = yield* createEagerBuffer(observed);
      source.add(1);
      source.add(2);
      source.add(3);
      yield* call(() => collected.promise);
      expect(buffer.drain()).toEqual([1, 2, 3]);
    });
  });

  it("atomically separates values arriving between downstream drains", async () => {
    await run(function* () {
      const source = createQueue<number, void>();
      const first = deferred();
      const second = deferred();
      let count = 0;
      const observed = observeValues(streamFromQueue(source), () => {
        count += 1;
        if (count === 3) {
          first.resolve();
        }
        if (count === 5) {
          second.resolve();
        }
      });
      const buffer = yield* createEagerBuffer(observed);
      source.add(1);
      source.add(2);
      source.add(3);
      yield* call(() => first.promise);
      expect(buffer.drain()).toEqual([1, 2, 3]);
      expect(buffer.drain()).toEqual([]);

      source.add(4);
      source.add(5);
      yield* call(() => second.promise);
      expect(buffer.drain()).toEqual([4, 5]);
    });
  });

  it("retains the final batch and completion value", async () => {
    await run(function* () {
      const source = createQueue<number, string>();
      const settled = deferred();
      const observed = observeValues(
        streamFromQueue(source),
        () => undefined,
        () => settled.resolve(),
      );
      const buffer = yield* createEagerBuffer(observed);
      source.add(1);
      source.close("finished");
      yield* call(() => settled.promise);
      expect(buffer.drain()).toEqual([1]);
      expect(buffer.state).toEqual({ status: "done", value: "finished" });
    });
  });

  it("halts the eager source task with its owning scope", async () => {
    await run(function* () {
      const started = deferred();
      const stopped = deferred();
      let sourceStopped = false;
      const source: Stream<number, void> = resource(function* (provide) {
        yield* provide({
          *next() {
            started.resolve();
            try {
              yield* suspend();
              return { done: true, value: undefined };
            } finally {
              sourceStopped = true;
              stopped.resolve();
            }
          },
        });
      });
      const owner = yield* spawn(function* () {
        yield* createEagerBuffer(source);
        yield* suspend();
      });

      yield* call(() => started.promise);
      yield* owner.halt();
      yield* call(() => stopped.promise);
      expect(sourceStopped).toBe(true);
    });
  });

  it("exposes source failure without discarding already collected values", async () => {
    await run(function* () {
      let calls = 0;
      const source: Stream<number, void> = resource(function* (provide) {
        yield* provide({
          *next() {
            calls += 1;
            if (calls === 1) {
              return { done: false, value: 1 };
            }
            throw new Error("planned source failure");
          },
        });
      });
      const settled = deferred();
      const observed = observeValues(
        source,
        () => undefined,
        () => settled.resolve(),
      );
      const buffer = yield* createEagerBuffer(observed);
      yield* call(() => settled.promise);
      expect(buffer.drain()).toEqual([1]);
      expect(buffer.state).toMatchObject({
        status: "error",
        error: { message: "planned source failure" },
      });
    });
  });
});
