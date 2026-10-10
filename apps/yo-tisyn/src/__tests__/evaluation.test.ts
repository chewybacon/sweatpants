import { describe, expect, it } from "vitest";
import { run, scoped, spawn, suspend, withResolvers, type Operation } from "effection";
import { parseDSL } from "@tisyn/dsl";
import {
  createEvaluation,
  EVALUATION_LIMITS,
  TisynEvaluationPort,
  type Evaluation,
} from "../evaluation.ts";
import { createNodeEvaluationDriver } from "../evaluation-node.ts";

function withNode<T>(body: () => Operation<T>): Promise<T> {
  return run(function* () {
    yield* TisynEvaluationPort.installDriver(createNodeEvaluationDriver());
    return yield* body();
  });
}

describe("Tisyn evaluation", () => {
  it("fails closed without a driver, even for pure computation", async () => {
    await expect(run(() => createEvaluation(parseDSL("Add(20,22)")))).rejects.toThrow(
      "No Tisyn evaluation driver is installed",
    );
  });

  it("bounds effectful loops before exposing an over-budget tool invocation", async () => {
    await expect(
      withNode(function* () {
        const kernel = yield* createEvaluation(
          parseDSL('While(true,[Eval("echo",{"message":"again"})])'),
        );
        for (let i = 0; i < EVALUATION_LIMITS.toolCalls; i++) {
          expect(yield* kernel.next({ message: "again" })).toEqual({
            done: false,
            value: { id: "echo", data: { message: "again" } },
          });
        }
        yield* kernel.next({ message: "again" });
      }),
    ).rejects.toThrow("exceeded 256 tool calls");
  });

  it("returns a finite while's last body value", async () => {
    await withNode(function* () {
      const kernel = yield* createEvaluation(
        parseDSL('While(Eq(Get(Eval("ask",{"message":"Continue?"}),"action"),"accept"),[42])'),
      );
      expect((yield* kernel.next()).done).toBe(false);
      expect((yield* kernel.next({ action: "accept" })).done).toBe(false);
      expect(yield* kernel.next({ action: "decline" })).toEqual({ done: true, value: 42 });
    });
  });

  it("feeds back a reply and returns the program result", async () => {
    await withNode(function* () {
      // Each advance has its own timeout. Human wait time holds no running VM script.
      const kernel = yield* createEvaluation(parseDSL('Seq(Eval("ask",{"message":"Reply"}),42)'));
      expect((yield* kernel.next()).done).toBe(false);
      expect(yield* kernel.next({ action: "decline" })).toEqual({ done: true, value: 42 });
    });
  });

  it("keeps concurrent evaluator sessions separate", async () => {
    await withNode(function* () {
      const first = yield* createEvaluation(parseDSL('Eval("ask",{"message":"first"})'));
      const second = yield* createEvaluation(parseDSL('Eval("ask",{"message":"second"})'));
      expect(yield* first.next()).toMatchObject({ value: { data: { message: "first" } } });
      expect(yield* second.next()).toMatchObject({ value: { data: { message: "second" } } });
      expect(yield* second.next("two")).toEqual({ done: true, value: "two" });
      expect(yield* first.next("one")).toEqual({ done: true, value: "one" });
    });
  });

  it.each(["before", "after"])(
    "observes open, advance, and cleanup with middleware installed %s the driver",
    async (order) => {
      const events: string[] = [];
      await run(function* () {
        function* observe() {
          yield* TisynEvaluationPort.api.around({
            *open(args, next) {
              events.push("open");
              return yield* next(...args);
            },
            *advance(args, next) {
              events.push("advance");
              return yield* next(...args);
            },
            *close(args, next) {
              yield* next(...args);
              events.push("close");
            },
          });
        }
        if (order === "before") {
          yield* observe();
        }
        yield* TisynEvaluationPort.installDriver(createNodeEvaluationDriver());
        if (order === "after") {
          yield* observe();
        }
        const evaluator = yield* createEvaluation(parseDSL("42"));
        expect(yield* evaluator.next()).toEqual({ done: true, value: 42 });
      });
      expect(events).toEqual(["open", "advance", "close"]);
    },
  );

  it.each(["return", "throw", "cancel"])("releases suspended compute on scope %s", async (exit) => {
    const driver = createNodeEvaluationDriver();
    const opened: string[] = [];
    const closed: string[] = [];
    await run(function* () {
      yield* TisynEvaluationPort.installDriver(driver);
      yield* TisynEvaluationPort.api.around({
        *open(args, next) {
          const handle = yield* next(...args);
          opened.push(handle);
          return handle;
        },
        *close([handle], next) {
          yield* next(handle);
          closed.push(handle);
        },
      });
      const ready = withResolvers<Evaluation>("evaluation suspended at ask");
      const owner = yield* spawn(function* () {
        const evaluator = yield* createEvaluation(parseDSL('Eval("ask",{"message":"Reply"})'));
        expect((yield* evaluator.next()).done).toBe(false);
        ready.resolve(evaluator);
        yield* suspend();
      });
      const evaluator = yield* ready.operation;
      if (exit === "cancel") {
        yield* owner.halt();
        expect(closed).toEqual(opened);
        try {
          yield* evaluator.next("too late");
          throw new Error("Expected a closed evaluation");
        } catch (error) {
          expect(String(error)).toContain("Tisyn evaluation is closed");
        }
      }
      if (exit === "throw") {
        // Catch the failure outside the child scope, after its resources close.
        try {
          yield* scoped(function* () {
            const abandoned = yield* createEvaluation(
              parseDSL('Eval("ask",{"message":"abandoned"})'),
            );
            expect((yield* abandoned.next()).done).toBe(false);
            throw new Error("caller failed");
          });
        } catch (error) {
          expect(String(error)).toContain("caller failed");
        }
        expect(closed).toContain(opened[1]);
      }
      // On return the parent also halts its still-suspended child.
    });
    expect(new Set(closed)).toEqual(new Set(opened));
    expect(closed).toHaveLength(opened.length);
    for (const handle of opened) {
      // Probe the real driver again: closure released its stored VM context.
      await expect(
        run(function* () {
          yield* TisynEvaluationPort.installDriver(driver);
          yield* TisynEvaluationPort.api.operations.advance(handle, "stale");
        }),
      ).rejects.toThrow("Unknown or closed Tisyn evaluation handle");
    }
  });

  it("does not retain installation in an unrelated scope", async () => {
    await withNode(function* () {
      const evaluator = yield* createEvaluation(parseDSL("42"));
      expect(yield* evaluator.next()).toEqual({ done: true, value: 42 });
    });
    await expect(run(() => createEvaluation(parseDSL("42")))).rejects.toThrow(
      "No Tisyn evaluation driver is installed",
    );
  });
});
