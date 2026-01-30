import { describe, it, expect } from "@effectionx/vitest";
import { resource, createContext } from "effection";
import { z } from "zod";
import { createProtocol, createImplementation } from "../create.ts";
import type { Stream } from "effection";

describe("createProtocol", () => {
  it("should create a protocol with methods", function* () {
    const protocol = createProtocol({
      echo: {
        input: z.object({ message: z.string() }),
        progress: z.never(),
        output: z.object({ echoed: z.string() }),
      },
    });

    expect(protocol.methods.echo).toBeDefined();
    expect(protocol.methods.echo.input).toBeDefined();
    expect(protocol.methods.echo.output).toBeDefined();
  });

  it("should create a protocol with multiple methods", function* () {
    const protocol = createProtocol({
      search: {
        input: z.object({ query: z.string() }),
        progress: z.object({ percent: z.number() }),
        output: z.object({ results: z.array(z.string()) }),
      },
      notify: {
        input: z.object({ message: z.string() }),
        progress: z.never(),
        output: z.object({ ok: z.boolean() }),
      },
    });

    expect(Object.keys(protocol.methods)).toEqual(["search", "notify"]);
  });
});

describe("createImplementation", () => {
  it("should create an inspector with attach()", function* () {
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

    expect(inspector.protocol).toBe(protocol);
    expect(typeof inspector.attach).toBe("function");
  });

  it("should yield a handle when attached", function* () {
    const protocol = createProtocol({
      greet: {
        input: z.object({ name: z.string() }),
        progress: z.never(),
        output: z.object({ greeting: z.string() }),
      },
    });

    const inspector = createImplementation(protocol, function* () {
      return {
        greet(args): Stream<never, { greeting: string }> {
          return resource(function* (provide) {
            yield* provide({
              *next() {
                return { done: true, value: { greeting: `Hello, ${args.name}!` } };
              },
            });
          });
        },
      };
    });

    const handle = yield* inspector.attach();

    expect(handle.protocol).toBe(protocol);
    expect(typeof handle.methods.greet).toBe("function");
    expect(typeof handle.invoke).toBe("function");
  });

  it("should invoke methods via handle.invoke()", function* () {
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

    const handle = yield* inspector.attach();
    const stream = handle.invoke({ name: "add", args: { a: 2, b: 3 } });
    const subscription = yield* stream;
    const result = yield* subscription.next();

    expect(result.done).toBe(true);
    expect(result.value).toEqual({ sum: 5 });
  });

  it("should invoke methods directly via handle.methods", function* () {
    const protocol = createProtocol({
      multiply: {
        input: z.object({ a: z.number(), b: z.number() }),
        progress: z.never(),
        output: z.object({ product: z.number() }),
      },
    });

    const inspector = createImplementation(protocol, function* () {
      return {
        multiply(args): Stream<never, { product: number }> {
          return resource(function* (provide) {
            yield* provide({
              *next() {
                return { done: true, value: { product: args.a * args.b } };
              },
            });
          });
        },
      };
    });

    const handle = yield* inspector.attach();
    const stream = handle.methods.multiply({ a: 4, b: 5 });
    const subscription = yield* stream;
    const result = yield* subscription.next();

    expect(result.done).toBe(true);
    expect(result.value).toEqual({ product: 20 });
  });

  it("should support progress updates in stream", function* () {
    const protocol = createProtocol({
      process: {
        input: z.object({ items: z.number() }),
        progress: z.object({ processed: z.number() }),
        output: z.object({ total: z.number() }),
      },
    });

    const inspector = createImplementation(protocol, function* () {
      return {
        process(args): Stream<{ processed: number }, { total: number }> {
          return resource(function* (provide) {
            let current = 0;
            yield* provide({
              *next() {
                if (current < args.items) {
                  current++;
                  return { done: false, value: { processed: current } };
                }
                return { done: true, value: { total: current } };
              },
            });
          });
        },
      };
    });

    const handle = yield* inspector.attach();
    const stream = handle.invoke({ name: "process", args: { items: 3 } });
    const subscription = yield* stream;

    // Collect progress updates
    const progress: { processed: number }[] = [];
    let result = yield* subscription.next();
    while (!result.done) {
      progress.push(result.value);
      result = yield* subscription.next();
    }

    expect(progress).toEqual([
      { processed: 1 },
      { processed: 2 },
      { processed: 3 },
    ]);
    expect(result.value).toEqual({ total: 3 });
  });

  it("should allow implementation to access context", function* () {
    const ConfigContext = createContext<{ prefix: string }>("config");

    const protocol = createProtocol({
      format: {
        input: z.object({ text: z.string() }),
        progress: z.never(),
        output: z.object({ formatted: z.string() }),
      },
    });

    const inspector = createImplementation(protocol, function* () {
      // Implementation can access context during attach
      const config = yield* ConfigContext.expect();

      return {
        format(args): Stream<never, { formatted: string }> {
          return resource(function* (provide) {
            yield* provide({
              *next() {
                return {
                  done: true,
                  value: { formatted: `${config.prefix}: ${args.text}` },
                };
              },
            });
          });
        },
      };
    });

    // Set context before attaching
    yield* ConfigContext.set({ prefix: "LOG" });
    const handle = yield* inspector.attach();

    const stream = handle.invoke({ name: "format", args: { text: "hello" } });
    const subscription = yield* stream;
    const result = yield* subscription.next();

    expect(result.value).toEqual({ formatted: "LOG: hello" });
  });
});
