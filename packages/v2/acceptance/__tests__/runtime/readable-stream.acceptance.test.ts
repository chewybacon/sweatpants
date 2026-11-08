import { expect, it } from "vitest";
import {
  createBufferedSignal,
  createPullStream,
  createReadableStream,
  type Runtime,
} from "@sweatpan.ts/runtime";
import { createLatch } from "@sweatpan.ts/testing";
import { forEachRuntime } from "./assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: lazy body compacts deltas to the reader's pace and closes after drain`, async () => {
    const buffer = createBufferedSignal<string, string, Y>(runtime);
    let subscribed = 0;
    const source = {
      *[Symbol.iterator]() {
        subscribed++;
        return yield* buffer.from(0, (previous, next) => previous + next);
      },
    };
    const body = createReadableStream(runtime, source);
    expect(subscribed).toBe(0);
    buffer.send("Hel");
    buffer.send("lo");
    const reader = body.getReader();
    expect(await reader.read()).toEqual({ done: false, value: "Hello" });
    expect(subscribed).toBe(1);
    const next = reader.read();
    buffer.send(", ");
    expect(await next).toEqual({ done: false, value: ", " });
    buffer.send("wor");
    buffer.send("ld");
    buffer.close("done");
    expect(await reader.read()).toEqual({ done: false, value: "world" });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it(`${runtime.name}: client cancel halts the reader and joins its cleanup`, async () => {
    const parked = createLatch<void>();
    let released = false;
    const source = {
      *[Symbol.iterator]() {
        yield* runtime.composition.ensure(function* () {
          released = true;
        });
        return yield* createPullStream<number, void, Y, Y>(
          runtime.composition,
          () =>
            function* () {
              parked.resolve();
              return yield* runtime.fromPromise(() => new Promise<never>(() => undefined));
            },
        );
      },
    };
    const reader = createReadableStream(runtime, source).getReader();
    const read = reader.read();
    await parked.promise;
    await reader.cancel("client gone");
    expect(released).toBe(true);
    expect(await read).toEqual({ done: true, value: undefined });
  });

  it(`${runtime.name}: producer failure errors the body`, async () => {
    const buffer = createBufferedSignal<number, void, Y>(runtime);
    const reader = createReadableStream(runtime, buffer).getReader();
    buffer.send(1);
    buffer.fail(new Error("producer failed"));
    expect(await reader.read()).toEqual({ done: false, value: 1 });
    await expect(reader.read()).rejects.toThrow("producer failed");
  });
});
