import assert from "node:assert/strict";
import { test } from "node:test";
import { run, type Operation } from "effection";
import type {
  DurableProgramContext,
  RecordOptions,
  RecordAttemptContext,
} from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";
import { LuaEvaluationPort } from "../evaluation.ts";
import { runLuaReplay } from "../replay.ts";
import { luaFuelPolicy } from "../fuel.ts";
import { invokeWasm } from "../wasm-node.mts";

// Mechanical record harness: accepted values survive reconstruction of compute.
function recorded(values: Map<string, Json>): Pick<DurableProgramContext, "record"> {
  return {
    *record<T extends Json>(
      options: RecordOptions,
      operation: (attempt: RecordAttemptContext) => Operation<T>,
    ): Operation<T> {
      if (!values.has(options.key)) {
        const value = yield* operation({
          pullId: "invocation-1",
          attemptId: "attempt-1",
          cancellation: new AbortController().signal,
        });
        values.set(options.key, value);
      }
      return structuredClone(values.get(options.key)) as T;
    },
  };
}

test("durable-tool replay reconstructs accepted compute without calling the evaluator", async () => {
  const values = new Map<string, Json>();
  const options = {
    source: "return {answer = 42}",
    context: recorded(values),
    fuelPolicy: luaFuelPolicy,
    *approveComputation() {
      throw Error("Unexpected approval");
    },
    *exchange() {
      throw Error("Unexpected capability");
    },
  };
  const first = await run(function* () {
    yield* LuaEvaluationPort.installDriver({ execute: invokeWasm });
    return yield* runLuaReplay(options);
  });
  assert.deepEqual(first, { answer: 42 });
  assert.equal(values.size, 2);
  const replay = await run(function* () {
    yield* LuaEvaluationPort.installDriver({
      *execute() {
        throw Error("Replayed compute executed");
      },
    });
    return yield* runLuaReplay({ ...options, context: recorded(values) });
  });
  assert.deepEqual(replay, first);
  assert.equal(values.size, 2);
});

test("evaluator failure becomes a recorded diagnostic and remains observable on replay", async () => {
  const values = new Map<string, Json>();
  const options = {
    source: "return 42",
    context: recorded(values),
    fuelPolicy: luaFuelPolicy,
    *approveComputation() {
      throw Error("Unexpected approval");
    },
    *exchange() {
      throw Error("Unexpected capability");
    },
  };
  const result = await run(function* () {
    yield* LuaEvaluationPort.installDriver({
      *execute() {
        throw Error("VM unavailable");
      },
    });
    return yield* runLuaReplay(options);
  });
  assert.deepEqual(result, {
    status: "failed",
    diagnostic: {
      message: JSON.stringify({ code: "lua_execution_error", message: "Error: VM unavailable" }),
    },
    completedEffects: 0,
  });
  const replay = await run(function* () {
    yield* LuaEvaluationPort.installDriver({ execute: invokeWasm });
    return yield* runLuaReplay({ ...options, context: recorded(values) });
  });
  assert.deepEqual(replay, result);
});

test("capability replies resume the guest with stable invocation identity and effect order", async () => {
  const requests: unknown[] = [];
  const result = await run(function* () {
    yield* LuaEvaluationPort.installDriver({ execute: invokeWasm });
    return yield* runLuaReplay({
      source: `local first = workflow.effect("first", {name="first", input=7})
        return workflow.effect("second", {name="second", input=first})`,
      context: recorded(new Map()),
      fuelPolicy: luaFuelPolicy,
      *approveComputation() {
        throw Error("Unexpected approval");
      },
      *exchange({ capability: request, completedEffects: count, invocationId }) {
        requests.push({ request, count, invocationId });
        return { kind: "resume", value: count === 0 ? "accepted" : "done" };
      },
    });
  });
  assert.equal(result, "done");
  assert.deepEqual(requests, [
    { request: { name: "first", input: 7 }, count: 0, invocationId: "invocation-1" },
    { request: { name: "second", input: "accepted" }, count: 1, invocationId: "invocation-1" },
  ]);
});

test("a capability stop returns the adapter result without advancing to another effect", async () => {
  const requests: string[] = [];
  const stopped = { status: "failed", diagnostic: { message: "Request rejected" } };
  const result = await run(function* () {
    yield* LuaEvaluationPort.installDriver({ execute: invokeWasm });
    return yield* runLuaReplay({
      source: `workflow.effect("first", {name="first", input=false})
        return workflow.effect("sentinel", {name="sentinel", input=true})`,
      context: recorded(new Map()),
      fuelPolicy: luaFuelPolicy,
      *approveComputation() {
        throw Error("Unexpected approval");
      },
      *exchange({ capability: request }) {
        requests.push(request.name);
        return { kind: "stop", result: stopped };
      },
    });
  });
  assert.deepEqual(result, stopped);
  assert.deepEqual(requests, ["first"]);
});
