import { expect, it, onTestFinished } from "vitest";
import type { Work } from "@standard-durability/core";
import { createBufferedSignal, type Runtime } from "@sweatpan.ts/runtime";
import { createLatch } from "@sweatpan.ts/testing";
import { forEachRuntime } from "./assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task;
  }
  it(`${runtime.name}: producer completes with no reader; reconnect drains from its own cursor`, async () => {
    const buffer = createBufferedSignal<string, string, Y>(runtime);
    const advance = createLatch<void>();
    const producing = createLatch<void>();
    let released = false;
    const producer = start(function* () {
      yield* runtime.composition.ensure(function* () {
        released = true;
      });
      buffer.send("first");
      producing.resolve();
      yield* runtime.fromPromise(() => advance.promise);
      buffer.send("second");
      buffer.send("third");
      buffer.close("parked");
    });
    await Promise.race([producing.promise, producer.result]);
    const escaped = await start(function* () {
      const reader = yield* buffer;
      expect(yield* reader.next()).toEqual({ done: false, value: "first" });
      return reader;
    }).result;
    expect(released).toBe(false);
    advance.resolve();
    await producer.result;
    expect(released).toBe(true);
    await expect(start(() => escaped.next()).result).rejects.toThrow("scope exited");
    await start(function* () {
      const resumed = yield* buffer.from(1);
      const fresh = yield* buffer;
      expect(yield* resumed.next()).toEqual({ done: false, value: "second" });
      expect(yield* fresh.next()).toEqual({ done: false, value: "first" });
      expect(yield* resumed.next()).toEqual({ done: false, value: "third" });
      expect(yield* resumed.next()).toEqual({ done: true, value: "parked" });
      expect(yield* resumed.next()).toEqual({ done: true, value: "parked" });
      const tail = yield* buffer.from(3);
      expect(yield* tail.next()).toEqual({ done: true, value: "parked" });
    }).result;
    expect(() => buffer.send("late")).toThrow("already terminal");
  });

  it(`${runtime.name}: readers wake independently and drain buffered values before retained failure`, async () => {
    const buffer = createBufferedSignal<number, void, Y>(runtime);
    const ready = [createLatch<void>(), createLatch<void>()];
    const failure = new Error("producer failed");
    const received: number[][] = [[], []];
    const tasks = ready.map((latch, index) =>
      start(function* () {
        const reader = yield* buffer;
        latch.resolve();
        while (true) {
          const item = yield* reader.next();
          if (item.done) {
            return;
          }
          received[index]!.push(item.value);
        }
      }),
    );
    await Promise.all(
      ready.map((latch, index) => Promise.race([latch.promise, tasks[index]!.result])),
    );
    buffer.send(1);
    buffer.send(2);
    buffer.fail(failure);
    buffer.close(); // First terminal wins.
    await Promise.all(tasks.map((task) => expect(task.result).rejects.toThrow("producer failed")));
    expect(received).toEqual([
      [1, 2],
      [1, 2],
    ]);
    await expect(
      start(function* () {
        const reader = yield* buffer.from(1);
        expect(yield* reader.next()).toEqual({ done: false, value: 2 });
        yield* reader.next();
      }).result,
    ).rejects.toThrow("producer failed");
  });

  it(`${runtime.name}: cancelling a waiting subscriber leaves retained production available`, async () => {
    const buffer = createBufferedSignal<number, void, Y>(runtime);
    const ready = createLatch<void>();
    const consumer = start(function* () {
      const reader = yield* buffer;
      ready.resolve();
      return yield* reader.next();
    });
    await Promise.race([ready.promise, consumer.result]);
    await consumer.cancel();
    buffer.send(42);
    buffer.close();
    await start(function* () {
      const reader = yield* buffer;
      expect(yield* reader.next()).toEqual({ done: false, value: 42 });
      expect(yield* reader.next()).toEqual({ done: true, value: undefined });
    }).result;
    for (const offset of [-1, 0.5, 2, NaN]) {
      await expect(start(() => buffer.from(offset)).result).rejects.toThrow(
        "outside retained history",
      );
    }
  });
});

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: compacted frames retain message boundaries and resumable source offsets`, async () => {
    type Delta = { message: string; text: string };
    const buffer = createBufferedSignal<Delta, void, Y>(runtime);
    const merge = (a: Delta, b: Delta): Delta | undefined =>
      a.message === b.message ? { message: a.message, text: a.text + b.text } : undefined;
    buffer.send({ message: "a", text: "one" });
    buffer.send({ message: "a", text: " two" });
    buffer.send({ message: "b", text: "three" });
    buffer.send({ message: "b", text: " four" });
    const task = runtime.start(function* () {
      const compacted = yield* buffer.from(0, merge);
      const raw = yield* buffer.from(0);
      expect(yield* compacted.next()).toEqual({
        done: false,
        value: { message: "a", text: "one two" },
      });
      expect(compacted.offset).toBe(2);
      expect(yield* raw.next()).toEqual({ done: false, value: { message: "a", text: "one" } });
      expect(raw.offset).toBe(1);
      const resumed = yield* buffer.from(compacted.offset, merge);
      expect(yield* resumed.next()).toEqual({
        done: false,
        value: { message: "b", text: "three four" },
      });
      expect(resumed.offset).toBe(4);
      // A single available delta returns immediately, without waiting to fill a frame.
      buffer.send({ message: "b", text: " five" });
      expect(yield* resumed.next()).toEqual({
        done: false,
        value: { message: "b", text: " five" },
      });
      buffer.close();
      expect(yield* resumed.next()).toEqual({ done: true, value: undefined });
      expect(resumed.offset).toBe(5);
    });
    onTestFinished(() => task.cancel());
    await task.result;
  });

  it(`${runtime.name}: failed compaction preserves the cursor and drains before producer failure`, async () => {
    const buffer = createBufferedSignal<string, void, Y>(runtime);
    buffer.send("one");
    buffer.send("two");
    buffer.fail(new Error("provider failed"));
    const task = runtime.start(function* () {
      let fail = true;
      const reader = yield* buffer.from(0, (a, b) => {
        if (fail) {
          throw new Error("projection failed");
        }
        return a + b;
      });
      const error = yield* runtime.composition.catchError(
        () => reader.next(),
        function* (error) {
          return String(error);
        },
      );
      expect(error).toContain("projection failed");
      expect(reader.offset).toBe(0);
      fail = false;
      expect(yield* reader.next()).toEqual({ done: false, value: "onetwo" });
      expect(reader.offset).toBe(2);
      return yield* reader.next();
    });
    onTestFinished(() => task.cancel());
    await expect(task.result).rejects.toThrow("provider failed");
  });
});

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: backlog compaction is bounded and resumes without losing source values`, async () => {
    const buffer = createBufferedSignal<number, void, Y>(runtime);
    for (let i = 0; i < 600; i++) {
      buffer.send(1);
    }
    buffer.close();
    const task = runtime.start(function* () {
      const reader = yield* buffer.from(0, (a, b) => a + b);
      expect(yield* reader.next()).toEqual({ done: false, value: 256 });
      expect(reader.offset).toBe(256);
      const resumed = yield* buffer.from(reader.offset, (a, b) => a + b, 100);
      for (const size of [100, 100, 100, 44]) {
        expect(yield* resumed.next()).toEqual({ done: false, value: size });
      }
      expect(resumed.offset).toBe(600);
      expect(yield* resumed.next()).toEqual({ done: true, value: undefined });
      for (const limit of [0, -1, 0.5, Infinity]) {
        const error = yield* runtime.composition.catchError(
          () => buffer.from(0, (a, b) => a + b, limit),
          function* (error) {
            return String(error);
          },
        );
        expect(error).toContain("positive safe integer");
      }
    });
    onTestFinished(() => task.cancel());
    await task.result;
  });
});
