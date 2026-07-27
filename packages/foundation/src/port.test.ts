import { run, scoped, spawn, sleep, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { definePort } from "./port.ts";

interface Greeter {
  greet(name: string): Operation<string>;
}

class GreeterUnavailable extends Error {
  readonly code = "greeter_unavailable";
}

const GreeterPort = definePort<Greeter>("foundation-test-greeter", {
  *greet(_name: string): Operation<string> {
    throw new GreeterUnavailable("no greeter installed");
  },
});

function driver(prefix: string): Greeter {
  return {
    *greet(name) {
      return `${prefix}:${name}`;
    },
  };
}

/**
 * Ports resolve through the Effection scope tree: a module-level declaration
 * with a per-scope implementation, not a process-wide singleton instance.
 */
describe("port scope semantics", () => {
  it("fails closed when nothing is installed", async () => {
    await run(function* () {
      let failure: unknown;
      try {
        yield* GreeterPort.api.operations.greet("ada");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(GreeterUnavailable);
    });
  });

  it("is inherited by child scopes but not visible to the parent", async () => {
    await run(function* () {
      const inner = yield* scoped(function* () {
        yield* GreeterPort.installDriver(driver("inner"));
        return yield* scoped(() => GreeterPort.api.operations.greet("ada"));
      });
      expect(inner).toBe("inner:ada");

      let failure: unknown;
      try {
        yield* GreeterPort.api.operations.greet("ada");
      } catch (error) {
        failure = error;
      }
      expect(failure, "installation must not leak to the parent scope").toBeInstanceOf(
        GreeterUnavailable,
      );
    });
  });

  it("lets a child scope shadow the parent's driver without affecting siblings", async () => {
    await run(function* () {
      yield* GreeterPort.installDriver(driver("outer"));

      const shadowed = yield* scoped(function* () {
        yield* GreeterPort.installDriver(driver("shadow"));
        return yield* GreeterPort.api.operations.greet("ada");
      });
      expect(shadowed).toBe("shadow:ada");
      expect(yield* GreeterPort.api.operations.greet("ada")).toBe("outer:ada");
    });
  });

  it("keeps middleware installed per scope and drops it when the scope exits", async () => {
    const log: string[] = [];
    await run(function* () {
      yield* GreeterPort.installDriver(driver("outer"));

      yield* scoped(function* () {
        yield* GreeterPort.api.around({
          *greet([name], next) {
            log.push(`observed:${name}`);
            return yield* next(name);
          },
        });
        expect(yield* GreeterPort.api.operations.greet("ada")).toBe("outer:ada");
      });

      expect(yield* GreeterPort.api.operations.greet("grace")).toBe("outer:grace");
    });
    expect(log).toEqual(["observed:ada"]);
  });

  it("isolates concurrent sibling scopes", async () => {
    await run(function* () {
      const results: string[] = [];
      const first = yield* spawn(() =>
        scoped(function* () {
          yield* GreeterPort.installDriver(driver("first"));
          yield* sleep(1);
          results.push(yield* GreeterPort.api.operations.greet("ada"));
        }),
      );
      const second = yield* spawn(() =>
        scoped(function* () {
          yield* GreeterPort.installDriver(driver("second"));
          results.push(yield* GreeterPort.api.operations.greet("grace"));
        }),
      );
      yield* first;
      yield* second;
      expect(results.toSorted()).toEqual(["first:ada", "second:grace"]);
    });
  });
});

/**
 * A member whose declared return type is not an `Operation`.
 *
 * This shape is legal, which is exactly why the rule below needs a test: the
 * downgrade is silent at the definition site and only bites whoever later tries
 * to write effectful middleware for the seam.
 */
interface SynchronousMember {
  now(): number;
}

const SynchronousPort = definePort<SynchronousMember>("synchronous-member", {
  now(): number {
    throw new Error("unavailable");
  },
});

describe("port members must return operations to stay interceptable", () => {
  it("dispatches a synchronous member and lifts it for callers", async () => {
    const observed = await run(function* () {
      yield* SynchronousPort.installDriver({ now: () => 41 });
      // `Api.operations` lifts a non-Operation return, so call sites cannot
      // tell the difference. Nothing fails until middleware is needed.
      return yield* SynchronousPort.api.operations.now();
    });
    expect(observed).toBe(41);
  });

  it("still allows purely synchronous middleware over that member", async () => {
    const observed = await run(function* () {
      yield* SynchronousPort.installDriver({ now: () => 41 });
      yield* SynchronousPort.api.around({ now: (args, next) => next(...args) + 1 });
      return yield* SynchronousPort.api.operations.now();
    });
    expect(observed).toBe(42);
  });

  it("rejects effectful middleware over a synchronous member", async () => {
    await run(function* () {
      yield* SynchronousPort.installDriver({ now: () => 41 });
      yield* SynchronousPort.api.around({
        // @ts-expect-error Around<T> derives Middleware<TArgs, number> here, so
        // middleware must return a number synchronously. It cannot be a
        // generator, which means no latency, fault, deadline, or authority
        // middleware can ever wrap this member.
        *now(args, next) {
          yield* sleep(1);
          return next(...args);
        },
      });
    });
  });

  it("accepts effectful middleware once the member returns an operation", async () => {
    const log: string[] = [];
    const observed = await run(function* () {
      yield* GreeterPort.installDriver(driver("driver"));
      yield* GreeterPort.api.around({
        *greet(args, next) {
          // The same interception the synchronous member cannot express.
          yield* sleep(1);
          log.push("before");
          return yield* next(...args);
        },
      });
      return yield* GreeterPort.api.operations.greet("ada");
    });
    expect(log).toEqual(["before"]);
    expect(observed).toBe("driver:ada");
  });
});
