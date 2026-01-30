import { describe, it, expect } from "@effectionx/vitest";
import { spawn, sleep, resource } from "effection";
import { z } from "zod";
import { createProtocol, createImplementation } from "../create.ts";
import { serveProtocol } from "../serve.ts";
import { createTransportPair } from "../../transport/pair.ts";
import { createCorrelation } from "../../transport/correlation.ts";
import type { Stream } from "effection";

describe("serveProtocol", () => {
  it("should handle a simple request/response", function* () {
    const protocol = createProtocol({
      echo: {
        input: z.object({ message: z.string() }),
        progress: z.never(),
        output: z.object({ echoed: z.string() }),
      },
    });

    const inspector = createImplementation(protocol, function* () {
      return {
        echo(args): Stream<never, { echoed: string }> {
          return resource(function* (provide) {
            yield* provide({
              *next() {
                return { done: true, value: { echoed: args.message } };
              },
            });
          });
        },
      };
    });

    const [principal, operative] = yield* createTransportPair();
    const correlated = yield* createCorrelation(principal);

    // Attach and serve the protocol on operative side
    const handle = yield* inspector.attach();
    yield* spawn(function* () {
      yield* serveProtocol(handle, operative);
    });

    // Give server time to start
    yield* sleep(0);

    // Send request from principal side
    const stream = correlated.request({
      id: "req-1",
      kind: "elicit",
      type: "echo",
      payload: { message: "hello" },
    });

    const subscription = yield* stream;
    const result = yield* subscription.next();

    expect(result.done).toBe(true);
    expect(result.value).toEqual({
      status: "accepted",
      content: { echoed: "hello" },
    });
  });

  it("should handle multiple concurrent requests", function* () {
    const protocol = createProtocol({
      add: {
        input: z.object({ a: z.number(), b: z.number() }),
        progress: z.never(),
        output: z.object({ sum: z.number() }),
      },
    });

    const inspector = createImplementation(protocol, function* () {
      return {
        add(args): Stream<never, { sum: number }> {
          return resource(function* (provide) {
            yield* provide({
              *next() {
                return { done: true, value: { sum: args.a + args.b } };
              },
            });
          });
        },
      };
    });

    const [principal, operative] = yield* createTransportPair();
    const correlated = yield* createCorrelation(principal);

    const handle = yield* inspector.attach();
    yield* spawn(function* () {
      yield* serveProtocol(handle, operative);
    });

    yield* sleep(0);

    // Send multiple concurrent requests
    const stream1 = correlated.request({
      id: "req-1",
      kind: "elicit",
      type: "add",
      payload: { a: 1, b: 2 },
    });

    const stream2 = correlated.request({
      id: "req-2",
      kind: "elicit",
      type: "add",
      payload: { a: 10, b: 20 },
    });

    const sub1 = yield* stream1;
    const sub2 = yield* stream2;

    const result1 = yield* sub1.next();
    const result2 = yield* sub2.next();

    expect(result1.value).toEqual({ status: "accepted", content: { sum: 3 } });
    expect(result2.value).toEqual({ status: "accepted", content: { sum: 30 } });
  });

  it("should stream progress updates", function* () {
    const protocol = createProtocol({
      process: {
        input: z.object({ count: z.number() }),
        progress: z.object({ step: z.number() }),
        output: z.object({ total: z.number() }),
      },
    });

    const inspector = createImplementation(protocol, function* () {
      return {
        process(args): Stream<{ step: number }, { total: number }> {
          return resource(function* (provide) {
            let current = 0;
            yield* provide({
              *next() {
                if (current < args.count) {
                  current++;
                  return { done: false, value: { step: current } };
                }
                return { done: true, value: { total: current } };
              },
            });
          });
        },
      };
    });

    const [principal, operative] = yield* createTransportPair();
    const correlated = yield* createCorrelation(principal);

    const handle = yield* inspector.attach();
    yield* spawn(function* () {
      yield* serveProtocol(handle, operative);
    });

    yield* sleep(0);

    const stream = correlated.request<{ step: number }, { status: "accepted"; content: { total: number } }>({
      id: "req-1",
      kind: "elicit",
      type: "process",
      payload: { count: 3 },
    });

    const subscription = yield* stream;

    // Collect progress updates
    const progress: { step: number }[] = [];
    let result = yield* subscription.next();
    while (!result.done) {
      progress.push(result.value);
      result = yield* subscription.next();
    }

    expect(progress).toEqual([
      { step: 1 },
      { step: 2 },
      { step: 3 },
    ]);
    expect(result.value).toEqual({
      status: "accepted",
      content: { total: 3 },
    });
  });

  it("should handle unknown method with error response", function* () {
    const protocol = createProtocol({
      known: {
        input: z.object({}),
        progress: z.never(),
        output: z.object({}),
      },
    });

    const inspector = createImplementation(protocol, function* () {
      return {
        known(): Stream<never, Record<string, never>> {
          return resource(function* (provide) {
            yield* provide({
              *next() {
                return { done: true, value: {} };
              },
            });
          });
        },
      };
    });

    const [principal, operative] = yield* createTransportPair();
    const correlated = yield* createCorrelation(principal);

    const handle = yield* inspector.attach();
    yield* spawn(function* () {
      yield* serveProtocol(handle, operative);
    });

    yield* sleep(0);

    // Request an unknown method
    const stream = correlated.request({
      id: "req-1",
      kind: "elicit",
      type: "unknown-method",
      payload: {},
    });

    const subscription = yield* stream;
    const result = yield* subscription.next();

    expect(result.done).toBe(true);
    expect(result.value).toEqual({
      status: "other",
      content: "Unknown method: unknown-method",
    });
  });

  it("should handle errors in method handlers", function* () {
    const protocol = createProtocol({
      failing: {
        input: z.object({}),
        progress: z.never(),
        output: z.object({}),
      },
    });

    const inspector = createImplementation(protocol, function* () {
      return {
        failing(): Stream<never, Record<string, never>> {
          return resource(function* (provide) {
            yield* provide({
              *next() {
                throw new Error("Something went wrong");
              },
            });
          });
        },
      };
    });

    const [principal, operative] = yield* createTransportPair();
    const correlated = yield* createCorrelation(principal);

    const handle = yield* inspector.attach();
    yield* spawn(function* () {
      yield* serveProtocol(handle, operative);
    });

    yield* sleep(0);

    const stream = correlated.request({
      id: "req-1",
      kind: "elicit",
      type: "failing",
      payload: {},
    });

    const subscription = yield* stream;
    const result = yield* subscription.next();

    expect(result.done).toBe(true);
    expect(result.value).toEqual({
      status: "other",
      content: "Something went wrong",
    });
  });
});
