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
