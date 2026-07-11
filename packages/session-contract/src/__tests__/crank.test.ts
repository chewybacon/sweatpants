import { action, run, type Operation } from "effection";
import { describe, expect, it } from "vitest";

import {
  all,
  canonicalSnapshot,
  createCrankRuntime,
  createCrankSession,
  createInMemoryCrankStore,
  effect,
  elicit,
  invoke,
  validateJournal,
  type Json,
  type ProgramFactory,
} from "../index.ts";

describe("replay crank", () => {
  it("parks without an owner and resumes a fresh generator from a response command", async () => {
    const store = createInMemoryCrankStore();
    let factories = 0;
    let effects = 0;
    const root: ProgramFactory = function* (input) {
      factories += 1;
      const sampled = yield* effect<string>("echo", input);
      const answer = yield* elicit<string>("approval", {
        key: "ok",
        message: "Continue?",
        responseSchema: { type: "string" },
      });
      return `${sampled}:${answer}`;
    };
    const runtime = createCrankRuntime({
      store,
      rootProgram: root,
      programVersion: "v1",
      restartAfterResolution: true,
      effects: {
        echo: (input) => {
          effects += 1;
          return input;
        },
      },
      ownerId: (() => {
        let id = 0;
        return () => `owner-${id++}`;
      })(),
    });
    const session = createCrankSession(store, "s1");

    await run(function* () {
      expect(yield* session.send("hello", { commandId: "send-1" })).toMatchObject({
        status: "accepted",
      });
      const parked = yield* runtime.activate("s1");
      expect(parked).toMatchObject({ state: "parked" });
      const coordination = yield* store.coordination("s1");
      expect(coordination.ownerId).toBeUndefined();
      expect(coordination.phase).toBe("parked");

      const records = yield* store.readJournal("s1");
      const pending = records.find(
        (record) =>
          record.payload.type === "pull_requested" && record.payload.descriptor.kind === "elicit",
      );
      expect(pending?.payload.type).toBe("pull_requested");
      if (pending?.payload.type !== "pull_requested") throw new Error("missing elicit");
      expect(
        yield* session.respond(pending.payload.pullId, "yes", { commandId: "respond-1" }),
      ).toMatchObject({ status: "accepted" });
      expect(yield* runtime.activate("s1")).toMatchObject({ state: "idle" });

      const completed = yield* store.readJournal("s1");
      validateJournal(completed);
      expect(completed.filter((record) => record.payload.type === "pull_requested")).toHaveLength(
        2,
      );
      expect(completed.filter((record) => record.payload.type === "pull_resolved")).toHaveLength(2);
      expect(completed.at(-1)?.payload).toMatchObject({
        type: "task_closed",
        result: { status: "ok", value: "hello:yes" },
      });
    });

    expect(effects).toBe(1);
    expect(factories).toBeGreaterThanOrEqual(3);
  });

  it("runs tools as deterministic children and closes them before parent resolution", async () => {
    const store = createInMemoryCrankStore();
    const child: ProgramFactory = function* (input) {
      return yield* effect<Json>("child.effect", input);
    };
    const root: ProgramFactory = function* () {
      const first = yield* invoke<Json>("tool.one", { n: 1 });
      const pair = yield* all<[Json, Json]>([
        { programId: "tool.one", input: { n: 2 } },
        { programId: "tool.one", input: { n: 3 } },
      ]);
      return [first, ...pair];
    };
    const runtime = createCrankRuntime({
      store,
      rootProgram: root,
      programVersion: "v1",
      programs: { "tool.one": child },
      effects: { "child.effect": (input) => input },
      ownerId: () => "owner",
    });
    const session = createCrankSession(store, "children");

    await run(function* () {
      yield* session.send(null, { commandId: "send" });
      expect(yield* runtime.activate("children")).toMatchObject({ state: "idle" });
      const records = yield* store.readJournal("children");
      validateJournal(records);
      const opens = records.filter((record) => record.payload.type === "task_opened");
      expect(
        opens.map((record) => record.payload.type === "task_opened" && record.payload.taskId),
      ).toEqual(["turn-0/root.0", "turn-0/root.1", "turn-0/root.2"]);
      for (const opened of opens) {
        if (opened.payload.type !== "task_opened") continue;
        const childClose = records.findIndex(
          (record) =>
            record.payload.type === "task_closed" &&
            record.payload.taskId === opened.payload.taskId,
        );
        const parentResolve = records.findIndex(
          (record) =>
            record.payload.type === "pull_resolved" &&
            record.payload.pullId === opened.payload.parentPullId,
        );
        expect(childClose).toBeLessThan(parentResolve);
      }
    });
  });

  it("starts all children concurrently while preserving source-order results", async () => {
    const store = createInMemoryCrankStore();
    const completionOrder: number[] = [];
    let releaseFirst: (() => void) | undefined;
    const child: ProgramFactory = function* (input) {
      return yield* effect<Json>("barrier", input);
    };
    const root: ProgramFactory = function* () {
      return yield* all<[Json, Json]>([
        { programId: "child", input: 0 },
        { programId: "child", input: 1 },
      ]);
    };
    const barrier = (input: Json): Operation<Json> =>
      (function* () {
        const index = Number(input);
        if (index === 0) {
          yield* action<void>((resolve) => {
            releaseFirst = resolve;
            return () => {
              releaseFirst = undefined;
            };
          });
        } else {
          completionOrder.push(index);
          releaseFirst?.();
        }
        if (index === 0) completionOrder.push(index);
        return input;
      })();
    const runtime = createCrankRuntime({
      store,
      rootProgram: root,
      programVersion: "v1",
      programs: { child },
      effects: { barrier },
      ownerId: () => "owner",
    });
    const session = createCrankSession(store, "concurrent");
    await run(function* () {
      yield* session.send(null, { commandId: "send" });
      yield* runtime.activate("concurrent");
      const records = yield* store.readJournal("concurrent");
      const firstAttempt = records.findIndex((record) => record.payload.type === "attempt_started");
      const childOpens = records
        .map((record, index) => (record.payload.type === "task_opened" ? index : -1))
        .filter((index) => index >= 0);
      expect(childOpens.every((index) => index < firstAttempt)).toBe(true);
      expect(records.at(-1)?.payload).toMatchObject({
        type: "task_closed",
        result: { status: "ok", value: [0, 1] },
      });
    });
    expect(completionOrder).toEqual([1, 0]);
  });

  it("uses canonical payload identity and detects same-version drift without dispatch", async () => {
    expect(canonicalSnapshot({ b: 2, a: 1 }).sha).toBe(canonicalSnapshot({ a: 1, b: 2 }).sha);
    const store = createInMemoryCrankStore();
    let prompt = "one";
    let calls = 0;
    const root: ProgramFactory = function* () {
      yield* effect("sample", { prompt });
      yield* elicit("wait", { key: "x", message: "x", responseSchema: {} });
      return null;
    };
    const runtime = createCrankRuntime({
      store,
      rootProgram: root,
      programVersion: "v1",
      effects: {
        sample: () => {
          calls += 1;
          return null;
        },
      },
      ownerId: () => `owner-${calls}`,
    });
    const session = createCrankSession(store, "drift");

    await run(function* () {
      yield* session.send(null, { commandId: "send" });
      expect(yield* runtime.activate("drift")).toMatchObject({ state: "parked" });
      prompt = "two";
      expect(yield* runtime.activate("drift")).toMatchObject({ state: "idle" });
      const records = yield* store.readJournal("drift");
      expect(records.at(-1)?.payload).toMatchObject({
        type: "task_closed",
        result: { status: "diverged", error: { code: "nondeterminism_detected" } },
      });
    });
    expect(calls).toBe(1);
  });

  it("replays a nested tool elicit and closes the child before the parent", async () => {
    const store = createInMemoryCrankStore();
    let rootFactories = 0;
    let childFactories = 0;
    const child: ProgramFactory = function* () {
      childFactories += 1;
      const answer = yield* elicit<Json>("tool.question", {
        key: "seat",
        message: "Seat?",
        responseSchema: { type: "string" },
      });
      return { answer };
    };
    const root: ProgramFactory = function* () {
      rootFactories += 1;
      return yield* invoke<Json>("tool.booking", {});
    };
    const runtime = createCrankRuntime({
      store,
      rootProgram: root,
      programVersion: "v1",
      programs: { "tool.booking": child },
      ownerId: () => `owner-${rootFactories}`,
    });
    const session = createCrankSession(store, "nested");

    await run(function* () {
      yield* session.send(null, { commandId: "send" });
      expect(yield* runtime.activate("nested")).toMatchObject({ state: "parked" });
      const parked = yield* store.readJournal("nested");
      const request = parked.find(
        (record) =>
          record.payload.type === "pull_requested" && record.payload.descriptor.kind === "elicit",
      );
      if (request?.payload.type !== "pull_requested") throw new Error("missing request");
      yield* session.respond(request.payload.pullId, "aisle", { commandId: "answer" });
      yield* runtime.activate("nested");
      const records = yield* store.readJournal("nested");
      const childClose = records.findIndex(
        (record) =>
          record.payload.type === "task_closed" && record.payload.taskId === "turn-0/root.0",
      );
      const parentResolution = records.findIndex(
        (record) =>
          record.payload.type === "pull_resolved" && record.payload.taskId === "turn-0/root",
      );
      expect(childClose).toBeLessThan(parentResolution);
      expect(records.at(-1)?.payload).toMatchObject({
        type: "task_closed",
        taskId: "turn-0/root",
        result: { status: "ok", value: { answer: "aisle" } },
      });
    });
    expect(rootFactories).toBe(2);
    expect(childFactories).toBe(2);
  });

  it("replays a parked tree to run cancellation cleanup and leaves the session open", async () => {
    const store = createInMemoryCrankStore();
    let cleanups = 0;
    const child: ProgramFactory = function* () {
      try {
        yield* elicit("tool.wait", { key: "wait", message: "Wait", responseSchema: {} });
        return "done";
      } finally {
        yield* effect("cleanup", null);
      }
    };
    const root: ProgramFactory = function* () {
      return yield* invoke("tool.child", {});
    };
    const runtime = createCrankRuntime({
      store,
      rootProgram: root,
      programVersion: "v1",
      programs: { "tool.child": child },
      effects: {
        cleanup: () => {
          cleanups += 1;
          return null;
        },
      },
      ownerId: () => `owner-${cleanups}`,
    });
    const session = createCrankSession(store, "cancel");

    await run(function* () {
      yield* session.send(null, { commandId: "send-0" });
      yield* runtime.activate("cancel");
      expect(yield* session.cancelTurn("turn-0", { commandId: "cancel-0" })).toMatchObject({
        status: "accepted",
      });
      yield* runtime.activate("cancel");
      const records = yield* store.readJournal("cancel");
      expect(
        records
          .filter((record) => record.payload.type === "task_closed")
          .map(
            (record) =>
              record.payload.type === "task_closed" && [
                record.payload.taskId,
                record.payload.result.status,
              ],
          ),
      ).toEqual([
        ["turn-0/root.0", "cancelled"],
        ["turn-0/root", "cancelled"],
      ]);
      expect(yield* session.send("next", { commandId: "send-1" })).toMatchObject({
        status: "accepted",
      });
    });
    expect(cleanups).toBe(1);
  });

  it("orders queued sends into separate turn roots and deduplicates commands", async () => {
    const store = createInMemoryCrankStore();
    const root: ProgramFactory = function* (input) {
      return input;
    };
    const runtime = createCrankRuntime({
      store,
      rootProgram: root,
      programVersion: "v1",
      ownerId: () => "owner",
    });
    const session = createCrankSession(store, "turns");
    await run(function* () {
      const first = yield* session.send("a", { commandId: "a" });
      expect(yield* session.send("a", { commandId: "a" })).toEqual({
        ...first,
        status: "duplicate",
      });
      yield* session.send("b", { commandId: "b" });
      yield* session.send("c", { commandId: "c" });
      yield* runtime.activate("turns");
      const records = yield* store.readJournal("turns");
      expect(
        records
          .filter((record) => record.payload.type === "turn_opened")
          .map((record) => record.payload.type === "turn_opened" && record.payload.turnId),
      ).toEqual(["turn-0", "turn-1", "turn-2"]);
    });
  });

  it("fences stale owners and reserves one response", async () => {
    let now = 0;
    const store = createInMemoryCrankStore({ now: () => now });
    await run(function* () {
      yield* store.ensureSession("fence");
      const first = yield* store.claim("fence", "a", 10);
      expect("status" in first).toBe(false);
      expect(yield* store.claim("fence", "b", 10)).toEqual({ status: "busy" });
      now = 20;
      const second = yield* store.claim("fence", "b", 10);
      if ("status" in first || "status" in second) throw new Error("claim failed");
      expect(second.epoch).toBeGreaterThan(first.epoch);
      expect(
        yield* store.appendExecution(first, 0, {
          type: "turn_opened",
          turnId: "turn-0",
          turnSeq: 0,
          taskId: "turn-0/root",
          commandId: "x",
          programVersion: "v1",
          input: null,
          inputSha: canonicalSnapshot(null).sha,
        }),
      ).toEqual({ status: "fenced" });
    });
  });
});
