import { describe, expect, it } from "vitest";
import {
  applyStage,
  collectProjection,
  generatorProjectionPipeline,
  projectionPipeline,
  resultWriter,
  runProjection,
  type ProjectionContext,
  type ProjectionWriter,
  writer,
} from "./projection-style.ts";

type Note = { readonly stage: string; readonly detail: string };

const context: ProjectionContext = { basis: "basis-1" };

function directProjection(values: readonly number[]): {
  readonly value: readonly number[];
  readonly notes: readonly Note[];
} {
  const normalized = values.map((value) => value / 10);
  const retained = normalized.filter((value) => value >= 0.5);
  const scored = retained.map((value) => value * 2);
  return {
    value: scored,
    notes: [
      { stage: "normalize", detail: `basis=${context.basis}` },
      { stage: "filter", detail: `retained=${retained.length}` },
      { stage: "score", detail: `count=${scored.length}` },
    ],
  };
}

function normalize(
  values: readonly number[],
  current: ProjectionContext,
): ProjectionWriter<readonly number[], Note> {
  return writer(values.map((value) => value / 10)).tell({
    stage: "normalize",
    detail: `basis=${current.basis}`,
  });
}

function filter(values: readonly number[]): ProjectionWriter<readonly number[], Note> {
  const retained = values.filter((value) => value >= 0.5);
  return writer(retained).tell({
    stage: "filter",
    detail: `retained=${retained.length}`,
  });
}

function score(values: readonly number[]): ProjectionWriter<readonly number[], Note> {
  const scored = values.map((value) => value * 2);
  return writer(scored).tell({
    stage: "score",
    detail: `count=${scored.length}`,
  });
}

function writerProjection(values: readonly number[]) {
  let result = writer<readonly number[], Note>(values);
  result = applyStage(result, context, normalize);
  result = applyStage(result, context, (input) => filter(input));
  result = applyStage(result, context, (input) => score(input));
  return result;
}

describe("projection styles", () => {
  it("matches a direct pure pipeline with a Writer pipeline", () => {
    expect(writerProjection([2, 5, 8, 10])).toMatchObject(directProjection([2, 5, 8, 10]));
  });

  it("map transforms a value without adding a note", () => {
    expect(writer(2).map((value) => value * 3)).toMatchObject({ value: 6, notes: [] });
  });

  it("bind composes stages and accumulates notes in order", () => {
    const result = writer<number, string>(1)
      .tell("first")
      .bind((value) => writer(value + 1).tell("second"))
      .bind((value) => writer(value * 2).tell("third"));

    expect(result).toMatchObject({
      value: 4,
      notes: ["first", "second", "third"],
    });
  });

  it("threads explicit projection context without using Effection Context", () => {
    const result = applyStage(
      writer<readonly number[], Note>([10]),
      { basis: "explicit-basis" },
      normalize,
    );

    expect(result).toMatchObject({
      value: [1],
      notes: [{ stage: "normalize", detail: "basis=explicit-basis" }],
    });
  });

  it("preserves structured errors while retaining notes before failure", () => {
    const result = resultWriter<number, "invalid", Note>({ ok: true, value: 2 })
      .tell({ stage: "input", detail: "accepted" })
      .bind(() =>
        resultWriter<number, "invalid", Note>({ ok: false, error: "invalid" }).tell({
          stage: "validate",
          detail: "rejected",
        }),
      )
      .bind(() => resultWriter({ ok: true, value: 99 }));

    expect(result.result).toEqual({ ok: false, error: "invalid" });
    expect(result.notes).toEqual([
      { stage: "input", detail: "accepted" },
      { stage: "validate", detail: "rejected" },
    ]);
  });

  it("keeps a state fold simpler than a Writer when no side channel is needed", () => {
    const events = ["append", "append", "replace"] as const;
    const folded = events.reduce(
      (state, event) => ({
        count: event === "replace" ? state.count : state.count + 1,
        generation: event === "replace" ? state.generation + 1 : state.generation,
      }),
      { count: 0, generation: 0 },
    );

    expect(folded).toEqual({ count: 2, generation: 1 });
  });
});

describe("generator-native projection pipeline", () => {
  const mapError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));

  it("lets stages yield notes, return values, and mix in pure map stages", () => {
    const calls: string[] = [];
    const pipeline = generatorProjectionPipeline<number, Error, string, { factor: number }>(
      mapError,
    )
      .through("increment", function* (input) {
        calls.push("increment");
        yield `increment:${input}`;
        return input + 1;
      })
      .map("multiply", (input, context) => {
        calls.push("multiply");
        return input * context.factor;
      })
      .through("render", function* (input) {
        calls.push("render");
        yield `render:${input}`;
        return `value=${input}`;
      });

    const iterator = pipeline.iterate(2, { factor: 3 });
    expect(iterator.next).toBeTypeOf("function");
    expect(calls).toEqual([]);

    const execution = collectProjection(pipeline, 2, { factor: 3 });
    expect(calls).toEqual(["increment", "multiply", "render"]);
    expect(execution.iterations).toEqual([
      {
        stage: "increment",
        index: 0,
        outcome: "accepted",
        notes: ["increment:2"],
      },
      {
        stage: "multiply",
        index: 1,
        outcome: "accepted",
        notes: [],
      },
      {
        stage: "render",
        index: 2,
        outcome: "accepted",
        notes: ["render:9"],
      },
    ]);
    expect(execution.final.result).toEqual({ ok: true, value: "value=9" });
    expect(execution.final.notes).toEqual(["increment:2", "render:9"]);
    // The separately constructed iterator remains unadvanced and owns no state.
    expect(calls).toEqual(["increment", "multiply", "render"]);
  });

  it("centralizes thrown-domain-error conversion and preserves yielded notes", () => {
    const calls: string[] = [];
    const pipeline = generatorProjectionPipeline<number, Error, string, {}>(mapError)
      .through("validate", function* (input) {
        calls.push("validate");
        yield `checking:${input}`;
        throw Object.assign(new Error("conflict"), {
          code: "public_root_conflict",
        });
      })
      .through("unreachable", function* (input) {
        calls.push("unreachable");
        return String(input);
      });

    const execution = collectProjection(pipeline, 7, {});

    expect(calls).toEqual(["validate"]);
    expect(execution.iterations).toHaveLength(1);
    expect(execution.iterations[0]).toMatchObject({
      stage: "validate",
      outcome: "rejected",
      notes: ["checking:7"],
      error: { code: "public_root_conflict" },
    });
    expect(execution.final.result).toMatchObject({
      ok: false,
      error: { code: "public_root_conflict" },
    });
    expect(execution.final.notes).toEqual(["checking:7"]);
  });
});

describe("iterated projection pipeline", () => {
  it("composes typed stages without executing them eagerly", () => {
    const calls: string[] = [];
    const pipeline = projectionPipeline<string, "invalid", string, ProjectionContext>()
      .through("parse", (input, current) => {
        calls.push("parse");
        return resultWriter({ ok: true, value: Number(input) }, [`parse:${current.basis}`]);
      })
      .through("double", (input, current) => {
        calls.push("double");
        return resultWriter({ ok: true, value: input * 2 }, [`double:${current.basis}`]);
      })
      .through("label", (input, current) => {
        calls.push("label");
        return resultWriter({ ok: true, value: `value=${input}` }, [`label:${current.basis}`]);
      });

    expect(pipeline.stages).toEqual(["parse", "double", "label"]);
    const iterator = pipeline.iterate("4", { basis: "lazy" });
    expect(calls).toEqual([]);

    const first = iterator.next();
    expect(first.done).toBe(false);
    expect(calls).toEqual(["parse"]);

    const second = iterator.next();
    expect(second.done).toBe(false);
    expect(calls).toEqual(["parse", "double"]);

    const third = iterator.next();
    expect(third.done).toBe(false);
    expect(calls).toEqual(["parse", "double", "label"]);

    const completed = iterator.next();
    expect(completed.done).toBe(true);
    if (completed.done) {
      expect(completed.value.result).toEqual({ ok: true, value: "value=8" });
      expect(completed.value.notes).toEqual(["parse:lazy", "double:lazy", "label:lazy"]);
    }
  });

  it("yields stage observations in order and returns the accumulated Writer", () => {
    const pipeline = projectionPipeline<number, never, string, {}>()
      .through("increment", (input) =>
        resultWriter({ ok: true, value: input + 1 }, ["incremented"]),
      )
      .through("render", (input) => resultWriter({ ok: true, value: String(input) }, ["rendered"]));

    const execution = collectProjection(pipeline, 1, {});

    expect(execution.iterations).toEqual([
      {
        stage: "increment",
        index: 0,
        outcome: "accepted",
        notes: ["incremented"],
      },
      {
        stage: "render",
        index: 1,
        outcome: "accepted",
        notes: ["rendered"],
      },
    ]);
    expect(execution.final.result).toEqual({ ok: true, value: "2" });
    expect(execution.final.notes).toEqual(["incremented", "rendered"]);
  });

  it("stops iteration at a structured failure", () => {
    const calls: string[] = [];
    const pipeline = projectionPipeline<number, "invalid", string, {}>()
      .through("validate", (input) => {
        calls.push("validate");
        return resultWriter({ ok: false, error: "invalid" }, [`rejected:${input}`]);
      })
      .through("unreachable", (input) => {
        calls.push("unreachable");
        return resultWriter({ ok: true, value: String(input) }, ["wrong"]);
      });

    const execution = collectProjection(pipeline, 3, {});

    expect(calls).toEqual(["validate"]);
    expect(execution.iterations).toEqual([
      {
        stage: "validate",
        index: 0,
        outcome: "rejected",
        error: "invalid",
        notes: ["rejected:3"],
      },
    ]);
    expect(execution.final.result).toEqual({ ok: false, error: "invalid" });
    expect(execution.final.notes).toEqual(["rejected:3"]);
  });

  it("can rerun one immutable pipeline with fresh Writer state", () => {
    const pipeline = projectionPipeline<number, never, number, {}>().through("record", (input) =>
      resultWriter({ ok: true, value: input * 2 }, [input]),
    );

    const first = runProjection(pipeline, 2, {});
    const second = runProjection(pipeline, 5, {});

    expect(first).toMatchObject({
      result: { ok: true, value: 4 },
      notes: [2],
    });
    expect(second).toMatchObject({
      result: { ok: true, value: 10 },
      notes: [5],
    });
    expect(pipeline.stages).toEqual(["record"]);
  });

  it("runs an observer for each yielded stage and returns the final value", () => {
    const observed: string[] = [];
    const pipeline = projectionPipeline<number, never, string, {}>()
      .through("increment", (input) =>
        resultWriter({ ok: true, value: input + 1 }, ["incremented"]),
      )
      .through("render", (input) => resultWriter({ ok: true, value: String(input) }, ["rendered"]));

    const final = runProjection(pipeline, 1, {}, (iteration) => {
      observed.push(iteration.stage);
    });

    expect(observed).toEqual(["increment", "render"]);
    expect(final.result).toEqual({ ok: true, value: "2" });
    expect(final.notes).toEqual(["incremented", "rendered"]);
  });

  it("freezes yielded observations and their note arrays", () => {
    const pipeline = projectionPipeline<number, never, string, {}>().through("observe", (input) =>
      resultWriter({ ok: true, value: input }, ["note"]),
    );
    const first = pipeline.iterate(1, {}).next();

    expect(first.done).toBe(false);
    if (!first.done) {
      expect(Object.isFrozen(first.value)).toBe(true);
      expect(Object.isFrozen(first.value.notes)).toBe(true);
    }
  });
});
