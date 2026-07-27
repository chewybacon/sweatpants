/**
 * Same behavioral contract exercised through all three styles so the trade-offs
 * are visible: mandatory path with nothing installed, driver behavior, and
 * observation middleware that must not change results.
 */
import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { installMemoryDriverA, StoreApiA, StoreUnavailable } from "./style-a-api-as-port.ts";
import { createMemoryDriverB, installMemoryDriverB, StoreApiB } from "./style-b-derived-facade.ts";
import { createMemoryDriverC, installMemoryDriverC, StoreApiC } from "./style-c-explicit-facade.ts";
import { createMemoryDriverD, installMemoryDriverD, StoreApiD } from "./style-d-typed-port.ts";

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
