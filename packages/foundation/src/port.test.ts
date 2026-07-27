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
 * A member declared synchronously on purpose.
 *
 * The return type is the contract for middleware as well as for callers, so
 * this shape states that nothing may ever make this call wait. That is a
 * legitimate invariant for a clock, epoch, or config read; it is also the trap
 * for anything that later needs fault or latency interception.
 */
interface SynchronousMember {
  now(): number;
}

const SynchronousPort = definePort<SynchronousMember>("synchronous-member", {
  now(): number {
    throw new Error("unavailable");
  },
});

describe("a port member's return type decides what middleware may do", () => {
  it("dispatches a synchronous member and lifts it for callers", async () => {
    const observed = await run(function* () {
      yield* SynchronousPort.installDriver({ now: () => 41 });
      // `Api.operations` lifts a non-Operation return, so call sites cannot
      // tell which choice was made. The consequence lands on middleware only.
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
        // generator. When the member is deliberately synchronous this rejection
        // is the guarantee; when it is accidental it is the trap.
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

describe("optional seams", () => {
  it("reports whether a driver is installed without exposing it", async () => {
    await run(function* () {
      expect(yield* GreeterPort.isInstalled()).toBe(false);
      yield* scoped(function* () {
        yield* GreeterPort.installDriver(driver("driver"));
        expect(yield* GreeterPort.isInstalled()).toBe(true);
      });
      // Presence follows scope exactly like the driver it reports on.
      expect(yield* GreeterPort.isInstalled()).toBe(false);
    });
  });

  it("refuses a value member that cannot fail closed", () => {
    expect(() =>
      definePort<{ readonly id: string }>("invalid-value-member", { id: "eagerly-read" }),
    ).toThrow(/cannot fail closed/);
  });
});

describe("one driver per scope", () => {
  it("rejects a second install in the same scope instead of ignoring it", async () => {
    await run(function* () {
      yield* GreeterPort.installDriver(driver("first"));
      let rejected: unknown;
      try {
        yield* GreeterPort.installDriver(driver("second"));
      } catch (error) {
        rejected = error;
      }
      // Drivers are terminal, so the second install would never have run.
      // Context.set replaces; installDriver must not pretend to.
      expect((rejected as Error).message).toMatch(/already has a driver installed in this scope/);
      expect(yield* GreeterPort.api.operations.greet("ada")).toBe("first:ada");
    });
  });

  it("still allows a child scope to shadow an installed driver", async () => {
    await run(function* () {
      yield* GreeterPort.installDriver(driver("outer"));
      yield* scoped(function* () {
        yield* GreeterPort.installDriver(driver("inner"));
        expect(yield* GreeterPort.api.operations.greet("ada")).toBe("inner:ada");
      });
      expect(yield* GreeterPort.api.operations.greet("ada")).toBe("outer:ada");
    });
  });
});
