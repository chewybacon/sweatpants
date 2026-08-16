import { describe, expect, it } from "vitest";
import {
  collectProjectionProgram,
  note,
  runProjectionProgram,
  stage,
  type ProjectionProgram,
} from "./projection-program-style.ts";

type Note = { readonly kind: string; readonly count: number };

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

function* parse(input: string): ProjectionProgram<number, Note> {
  return yield* stage("parse", function* () {
    yield* note({ kind: "parsed", count: input.length });
    return Number(input);
  });
}

function* double(input: number): ProjectionProgram<number, Note> {
  return yield* stage("double", function* () {
    yield* note({ kind: "doubled", count: input });
    return input * 2;
  });
}

describe("projection programs", () => {
  it("threads types across stages with no builder and no cast", () => {
    const outcome = runProjectionProgram(function* () {
      const parsed = yield* parse("21");
      const doubled = yield* double(parsed);
      // `label` is a string here purely because `yield*` returned the exact
      // type of each delegated program. No stage array, no erasure.
      const label = yield* stage<string, Note>("label", function* () {
        return `value=${doubled}`;
      });
      return label;
    }, toError);

    expect(outcome).toMatchObject({ ok: true, value: "value=42" });
    expect(outcome.notes).toEqual([
      { kind: "parsed", count: 2 },
      { kind: "doubled", count: 21 },
    ]);
  });

  it("composes sub-projections as nested stages", () => {
    function* preparation(input: string): ProjectionProgram<number, Note> {
      return yield* stage("prepare", function* () {
        const parsed = yield* parse(input);
        return yield* double(parsed);
      });
    }

    const execution = collectProjectionProgram(function* () {
      return yield* preparation("4");
    }, toError);

    expect(execution.outcome).toMatchObject({ ok: true, value: 8 });
    expect(execution.events.map((event) => [event.type, event.path.join("/")])).toEqual([
      ["enter", "prepare"],
      ["enter", "prepare/parse"],
      ["note", "prepare/parse"],
      ["exit", "prepare/parse"],
      ["enter", "prepare/double"],
      ["note", "prepare/double"],
      ["exit", "prepare/double"],
      ["exit", "prepare"],
    ]);
  });

  it("expresses branching and iteration that a stage array cannot", () => {
    function* program(values: readonly number[]): ProjectionProgram<number, Note> {
      let total = 0;
      for (const value of values) {
        if (value < 0) continue;
        total += yield* stage(`add:${value}`, function* () {
          yield* note({ kind: "added", count: value });
          return value;
        });
      }
      return total;
    }

    const execution = collectProjectionProgram(() => program([1, -5, 2]), toError);

    expect(execution.outcome).toMatchObject({ ok: true, value: 3 });
    expect(execution.outcome.notes).toEqual([
      { kind: "added", count: 1 },
      { kind: "added", count: 2 },
    ]);
    expect(
      execution.events.filter((event) => event.type === "enter").map((event) => event.path),
    ).toEqual([["add:1"], ["add:2"]]);
  });

  it("short-circuits on a thrown domain error and reports the failing stage path", () => {
    const reached: string[] = [];

    const outcome = runProjectionProgram(function* () {
      const parsed = yield* parse("2");
      yield* stage("validate", function* () {
        yield* note({ kind: "validating", count: parsed });
        throw Object.assign(new Error("conflict"), {
          code: "public_root_conflict",
        });
      });
      reached.push("unreachable");
      return parsed;
    }, toError);

    expect(reached).toEqual([]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({ code: "public_root_conflict" });
      expect(outcome.path).toEqual(["validate"]);
    }
    expect(outcome.notes).toEqual([
      { kind: "parsed", count: 1 },
      { kind: "validating", count: 2 },
    ]);
  });

  it("runs one program under different interpreters", () => {
    const program = function* (): ProjectionProgram<number, Note> {
      const parsed = yield* parse("5");
      return yield* double(parsed);
    };

    const plain = runProjectionProgram(program, toError);
    const traced: string[] = [];
    const observed = runProjectionProgram(program, toError, (event) => {
      if (event.type === "note") traced.push(event.note.kind);
    });

    expect(plain).toMatchObject({ ok: true, value: 10 });
    expect(observed).toMatchObject({ ok: true, value: 10 });
    expect(traced).toEqual(["parsed", "doubled"]);
  });
});
