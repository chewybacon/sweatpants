/**
 * Same behavioral contract exercised through styles A-E so the trade-offs are
 * visible: mandatory path with nothing installed, driver behavior, and
 * observation middleware that must not change results. Style F has focused
 * facade-injection tests below.
 */
import { run, scoped, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { installMemoryDriverA, StoreApiA, StoreUnavailable } from "../style-a-api-as-port.ts";
import { createMemoryDriverB, installMemoryDriverB, StoreApiB } from "../style-b-derived-facade.ts";
import {
  createMemoryDriverC,
  installMemoryDriverC,
  StoreApiC,
} from "../style-c-explicit-facade.ts";
import { createMemoryDriverD, installMemoryDriverD, StoreApiD } from "../style-d-typed-port.ts";
import {
  createMemoryDriverE,
  installDriverE,
  installMemoryDriverE,
  StoreApiE,
  useStoreE,
} from "../style-e-context-backed-port.ts";
import {
  createMemoryDriverF,
  installDriverF,
  installMemoryDriverF,
  StoreApiF,
  useStoreF,
} from "../style-f-context-api-facade.ts";

interface StyleUnderTest {
  readonly name: string;
  install(): Operation<void>;
  load(executionId: string): Operation<{ payload: string } | null>;
  commit(
    executionId: string,
    payload: string,
    expectedRevision: number | null,
  ): Operation<{ status: string }>;
  observe(log: string[]): Operation<void>;
}

const styles: readonly StyleUnderTest[] = [
  {
    name: "A: api as port",
    install: () => installMemoryDriverA(),
    load: (executionId) => StoreApiA.operations.load(executionId),
    commit: (executionId, payload, expectedRevision) =>
      StoreApiA.operations.commit({ executionId, payload }, expectedRevision),
    *observe(log) {
      yield* StoreApiA.around({
        *load([executionId], next) {
          log.push(`load:${executionId}`);
          return yield* next(executionId);
        },
        *commit([record, expectedRevision], next) {
          log.push(`commit:${record.executionId}`);
          return yield* next(record, expectedRevision);
        },
      });
    },
  },
  {
    name: "B: derived facade",
    install: () => installMemoryDriverB(),
    load: (executionId) => StoreApiB.operations.load(executionId),
    commit: (executionId, payload, expectedRevision) =>
      StoreApiB.operations.commit({ executionId, payload }, expectedRevision),
    *observe(log) {
      yield* StoreApiB.around({
        *load([executionId], next) {
          log.push(`load:${executionId}`);
          return yield* next(executionId);
        },
        *commit([record, expectedRevision], next) {
          log.push(`commit:${record.executionId}`);
          return yield* next(record, expectedRevision);
        },
      });
    },
  },
  {
    name: "C: explicit facade",
    install: () => installMemoryDriverC(),
    load: (executionId) => StoreApiC.operations.load(executionId),
    commit: (executionId, payload, expectedRevision) =>
      StoreApiC.operations.commit({ executionId, payload }, expectedRevision),
    *observe(log) {
      yield* StoreApiC.around({
        *load([executionId], next) {
          log.push(`load:${executionId}`);
          return yield* next(executionId);
        },
        *commit([record, expectedRevision], next) {
          log.push(`commit:${record.executionId}`);
          return yield* next(record, expectedRevision);
        },
      });
    },
  },
  {
    name: "D: typed port",
    install: () => installMemoryDriverD(),
    load: (executionId) => StoreApiD.operations.load(executionId),
    commit: (executionId, payload, expectedRevision) =>
      StoreApiD.operations.commit({ executionId, payload }, expectedRevision),
    *observe(log) {
      yield* StoreApiD.around({
        *load([executionId], next) {
          log.push(`load:${executionId}`);
          return yield* next(executionId);
        },
        *commit([record, expectedRevision], next) {
          log.push(`commit:${record.executionId}`);
          return yield* next(record, expectedRevision);
        },
      });
    },
  },
  {
    name: "E: context-backed facade",
    install: () => installMemoryDriverE(),
    load: (executionId) => StoreApiE.operations.load(executionId),
    commit: (executionId, payload, expectedRevision) =>
      StoreApiE.operations.commit({ executionId, payload }, expectedRevision),
    *observe(log) {
      yield* StoreApiE.around({
        *load([executionId], next) {
          log.push(`load:${executionId}`);
          return yield* next(executionId);
        },
        *commit([record, expectedRevision], next) {
          log.push(`commit:${record.executionId}`);
          return yield* next(record, expectedRevision);
        },
      });
    },
  },
];

describe.each(styles)("execution store style $name", (style) => {
  it("commits under CAS and rejects a stale revision with no middleware", async () => {
    await run(function* () {
      yield* style.install();
      expect(yield* style.commit("execution-1", "first", null)).toEqual({
        status: "accepted",
        revision: 0,
      });
      expect(yield* style.commit("execution-1", "second", null)).toEqual({
        status: "conflict",
        actualRevision: 0,
      });
      expect(yield* style.load("execution-1")).toMatchObject({ payload: "first" });
    });
  });

  it("supports observation middleware installed after the driver", async () => {
    const log: string[] = [];
    await run(function* () {
      yield* style.install();
      yield* style.observe(log);
      expect(yield* style.commit("execution-2", "value", null)).toEqual({
        status: "accepted",
        revision: 0,
      });
      expect(yield* style.load("execution-2")).toMatchObject({ payload: "value" });
    });
    expect(log).toEqual(["commit:execution-2", "load:execution-2"]);
  });

  it("supports observation middleware installed before the driver", async () => {
    const log: string[] = [];
    await run(function* () {
      yield* style.observe(log);
      yield* style.install();
      expect(yield* style.commit("execution-3", "value", null)).toEqual({
        status: "accepted",
        revision: 0,
      });
      expect(yield* style.load("execution-3")).toMatchObject({ payload: "value" });
    });
    expect(log).toEqual(["commit:execution-3", "load:execution-3"]);
  });
});

describe("context-backed facade", () => {
  it("resolves through a deeply nested context while API middleware still wraps the driver", async () => {
    const log: string[] = [];
    await run(function* () {
      yield* StoreApiE.around({
        *load([executionId], next) {
          log.push(`api-load:${executionId}`);
          return yield* next(executionId);
        },
        *commit([record, expectedRevision], next) {
          log.push(`before:${record.executionId}:${expectedRevision ?? "null"}`);
          const result = yield* next(record, expectedRevision);
          log.push(`after:${result.status}`);
          return result;
        },
      });

      yield* scoped(function* () {
        yield* installMemoryDriverE();
        yield* scoped(function* () {
          expect(
            yield* StoreApiE.operations.commit({ executionId: "nested", payload: "value" }, null),
          ).toEqual({ status: "accepted", revision: 0 });
          expect(yield* StoreApiE.operations.load("nested")).toEqual({
            executionId: "nested",
            payload: "value",
          });

          const injected = yield* useStoreE();
          expect(yield* injected.load("nested")).toEqual({
            executionId: "nested",
            payload: "value",
          });
        });
      });
    });
    // The module-level API call is wrapped; the trusted direct context call is
    // intentionally not routed back through the API middleware.
    expect(log).toEqual(["before:nested:null", "after:accepted", "api-load:nested"]);
  });
});

describe("context-backed middleware boundaries", () => {
  it("returns the exact raw driver instance installed in Context", async () => {
    await run(function* () {
      const driver = createMemoryDriverE();
      yield* installDriverE(driver);
      expect(yield* useStoreE()).toBe(driver);
    });
  });

  it("composes outer and inner API middleware around the Context-backed driver", async () => {
    const log: string[] = [];
    await run(function* () {
      yield* StoreApiE.around({
        *commit([record, expectedRevision], next) {
          log.push(`outer-before:${record.executionId}`);
          const result = yield* next(record, expectedRevision);
          log.push(`outer-after:${result.status}`);
          return result;
        },
      });

      yield* scoped(function* () {
        yield* installMemoryDriverE();
        yield* scoped(function* () {
          yield* StoreApiE.around({
            *commit([record, expectedRevision], next) {
              log.push(`inner-before:${record.executionId}`);
              const result = yield* next(record, expectedRevision);
              log.push(`inner-after:${result.status}`);
              return result;
            },
          });

          expect(
            yield* StoreApiE.operations.commit({ executionId: "layered", payload: "value" }, null),
          ).toEqual({ status: "accepted", revision: 0 });
        });
      });
    });

    expect(log).toEqual([
      "outer-before:layered",
      "inner-before:layered",
      "inner-after:accepted",
      "outer-after:accepted",
    ]);
  });

  it("shows that raw Context.expect() access intentionally bypasses API middleware", async () => {
    const log: string[] = [];
    await run(function* () {
      yield* StoreApiE.around({
        *load([executionId], next) {
          log.push(`api-load:${executionId}`);
          return yield* next(executionId);
        },
      });

      yield* scoped(function* () {
        yield* installMemoryDriverE();
        const injected = yield* useStoreE();
        yield* injected.load("raw");
      });
    });

    expect(log).toEqual([]);
  });
});

describe("context-injected API facade", () => {
  it("returns the API facade and preserves outer and inner middleware", async () => {
    const log: string[] = [];
    await run(function* () {
      yield* StoreApiF.around({
        *commit([record, expectedRevision], next) {
          log.push(`outer-before:${record.executionId}`);
          const result = yield* next(record, expectedRevision);
          log.push(`outer-after:${result.status}`);
          return result;
        },
      });

      yield* scoped(function* () {
        const rawDriver = createMemoryDriverF();
        yield* installDriverF(rawDriver);
        yield* scoped(function* () {
          yield* StoreApiF.around({
            *commit([record, expectedRevision], next) {
              log.push(`inner-before:${record.executionId}`);
              const result = yield* next(record, expectedRevision);
              log.push(`inner-after:${result.status}`);
              return result;
            },
          });

          const injected = yield* useStoreF();
          expect(injected).toBe(StoreApiF.operations);
          expect(injected).not.toBe(rawDriver);
          expect(yield* injected.commit({ executionId: "facade", payload: "value" }, null)).toEqual(
            { status: "accepted", revision: 0 },
          );
        });
      });
    });

    expect(log).toEqual([
      "outer-before:facade",
      "inner-before:facade",
      "inner-after:accepted",
      "outer-after:accepted",
    ]);
  });

  it("inherits the facade into a deeper scope without capturing the driver scope", async () => {
    await run(function* () {
      yield* scoped(function* () {
        yield* installMemoryDriverF();
        const outerFacade = yield* useStoreF();
        yield* scoped(function* () {
          const innerFacade = yield* useStoreF();
          expect(innerFacade).toBe(outerFacade);
          expect(yield* innerFacade.load("missing")).toBeNull();
        });
      });
    });
  });
});

describe("driver-shaped differences", () => {
  it("A has no driver object to conformance-test directly", async () => {
    await run(function* () {
      // Nothing installed: the mandatory path fails closed.
      yield* expectRejection(() => StoreApiA.operations.load("missing"));
    });
  });

  it("B, C, and D expose plain adapters that conformance suites can drive directly", async () => {
    await run(function* () {
      for (const driver of [createMemoryDriverB(), createMemoryDriverC(), createMemoryDriverD()]) {
        expect(yield* driver.commit({ executionId: "direct", payload: "x" }, null)).toEqual({
          status: "accepted",
          revision: 0,
        });
        expect(yield* driver.load("direct")).toEqual({ executionId: "direct", payload: "x" });
      }
    });
  });
});

function* expectRejection(operation: () => Operation<unknown>): Operation<void> {
  try {
    yield* operation();
  } catch (error) {
    expect(error).toBeInstanceOf(StoreUnavailable);
    return;
  }
  throw new Error("expected the uninstalled store to fail closed");
}
