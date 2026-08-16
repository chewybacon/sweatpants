import { describe, expect, it } from "vitest";
import { runProjectionProgram, stage, type ProjectionProgram } from "../projection.ts";
import { combine, FoldError, runFold } from "../fold.ts";
import {
  baseIndexes,
  byTagFold,
  deriveByHand,
  edgesFold,
  idsFold,
  resolveGraph,
  slotsFold,
  type BaseIndexes,
  type Item,
  type ResolvedGraph,
} from "./fold-fusion-style.ts";

const items: readonly Item[] = [
  { id: "a", parent: null, slot: 0, tag: "alpha" },
  { id: "b", parent: "a", slot: 0, tag: "beta" },
  { id: "c", parent: "a", slot: 1, tag: "alpha" },
  { id: "d", parent: "missing", slot: 0, tag: "beta" },
];

/** Counts every item the fold actually visits. */
function counted(source: readonly Item[], counter: { visits: number }): Iterable<Item> {
  return {
    *[Symbol.iterator]() {
      for (const item of source) {
        counter.visits += 1;
        yield item;
      }
    },
  };
}

function captureError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("applicative fold fusion", () => {
  it("computes every independent index in one traversal", () => {
    const counter = { visits: 0 };
    const base = runFold(baseIndexes, counted(items, counter));

    expect(counter.visits).toBe(items.length);
    expect([...base.ids]).toEqual(["a", "b", "c", "d"]);
    expect(base.byTag.get("alpha")).toEqual(["a", "c"]);
    expect(base.byTag.get("beta")).toEqual(["b", "d"]);
    expect(base.slots.get("c")).toBe(1);
    expect(base.edges).toEqual([
      { child: "b", parent: "a" },
      { child: "c", parent: "a" },
      { child: "d", parent: "missing" },
    ]);
  });

  it("costs one traversal per index when the folds are not fused", () => {
    const counter = { visits: 0 };
    // The shape indexRecordProjection is written in today: separate loops.
    runFold(idsFold, counted(items, counter));
    runFold(byTagFold, counted(items, counter));
    runFold(slotsFold, counted(items, counter));
    runFold(edgesFold, counted(items, counter));

    expect(counter.visits).toBe(items.length * 4);
  });

  it("matches the hand-fused loop exactly", () => {
    const composed = runFold(baseIndexes, items);
    const byHand = deriveByHand(items);

    expect(composed).toEqual(byHand.base);
    expect(resolveGraph(composed)).toEqual(byHand.resolved);
  });

  it("partitions edges only once the full id set is known", () => {
    const resolved = resolveGraph(runFold(baseIndexes, items));

    expect(resolved.attached.get("a")).toEqual(["b", "c"]);
    // "missing" never arrived, so its child stays pending rather than erroring.
    expect(resolved.pending.get("missing")).toEqual(["d"]);
    expect(resolved.attached.has("missing")).toBe(false);
  });

  it("uses a monadic spine for the dependent phase and fusion inside it", () => {
    const counter = { visits: 0 };
    const outcome = runProjectionProgram(
      function* (): ProjectionProgram<ResolvedGraph, never> {
        // Applicative: four indexes, one traversal.
        const base = yield* stage<BaseIndexes, never>("scan", function* () {
          return runFold(baseIndexes, counted(items, counter));
        });
        // Monadic: this stage cannot start until `scan` produced the id set.
        return yield* stage<ResolvedGraph, never>("resolve", function* () {
          return resolveGraph(base);
        });
      },
      (error) => error,
    );

    expect(outcome).toMatchObject({ ok: true });
    expect(counter.visits).toBe(items.length);
  });

  it("attributes a failure to the fold that raised it", () => {
    const duplicated: readonly Item[] = [...items, { ...items[0]! }];
    const error = captureError(() => runFold(baseIndexes, duplicated));

    expect(error).toBeInstanceOf(FoldError);
    expect(error).toMatchObject({ foldKey: "ids" });
  });

  it("reports the dependent stage when a sibling slot collides", () => {
    const colliding: readonly Item[] = [
      { id: "a", parent: null, slot: 0, tag: "alpha" },
      { id: "b", parent: "a", slot: 0, tag: "alpha" },
      { id: "c", parent: "a", slot: 0, tag: "beta" },
    ];
    const outcome = runProjectionProgram(
      function* (): ProjectionProgram<ResolvedGraph, never> {
        const base = yield* stage<BaseIndexes, never>("scan", function* () {
          return runFold(baseIndexes, colliding);
        });
        return yield* stage<ResolvedGraph, never>("resolve", function* () {
          return resolveGraph(base);
        });
      },
      (error) => error,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ path: ["resolve"] });
  });

  it("combines arbitrary folds without a cast at the call site", () => {
    const pair = combine({ ids: idsFold, slots: slotsFold });
    const result = runFold(pair, items);

    // Accumulator types differ (Set vs Map) yet both stay fully typed.
    expect(result.ids.has("a")).toBe(true);
    expect(result.slots.get("a")).toBe(0);
  });
});
