import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { Operation, Work } from "@standard-durability/core";
import {
  createModelProvider,
  createContextCounter,
  measureContextBudget,
  type ModelInfo,
} from "@sweatpan.ts/providers";
import {
  createProgramExecution,
  createProgramResolver,
  createScopedGuest,
  type ProgramInvocation,
  type ResolvedProgram,
} from "@sweatpan.ts/execution";
import { createResponseSubscriptions, createElicitationHandler } from "@sweatpan.ts/chat-client";
import { createHostedRecovery as createRecovery } from "@sweatpan.ts/testing";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import {
  createHosting,
  createEffectCapabilities,
  createAttemptNotifications,
} from "@sweatpan.ts/hosting";
import { installToolRouting, createToolAdmission } from "@sweatpan.ts/tools";
import { createBufferedSignal, type BufferedSignal, type Runtime } from "@sweatpan.ts/runtime";
import {
  createNotificationRig,
  createProtocolRig,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task;
  }
  it(`${runtime.name}: provider policy changes new subscriptions while existing readers retain their source`, async () => {
    const observed: string[] = [];
    function driver(label: string) {
      return {
        *stream(_request: string) {
          const source = createBufferedSignal<string, string, Y>(runtime);
          source.send(label);
          source.close(label);
          return yield* source.from(0);
        },
      };
    }
    const provider = createModelProvider(runtime.composition, "provider", driver("parent"));
    const task = start(function* () {
      yield* provider.around({
        *stream([request], next) {
          const reader = yield* next(request);
          return {
            *next() {
              const item = yield* reader.next();
              observed.push(item.value);
              return item;
            },
          };
        },
      });
      const parent = yield* provider.operations.stream("request");
      const values = yield* runtime.all(
        ["left", "right"].map(
          (label) =>
            function* () {
              return yield* runtime.composition.scoped(function* () {
                yield* provider.install(driver(label));
                const reader = yield* provider.operations.stream("request");
                const value = yield* reader.next();
                return value.value;
              });
            },
        ),
      );
      expect(values).toEqual(["left", "right"]);
      expect((yield* parent.next()).value).toBe("parent");
      const restored = yield* provider.operations.stream("request");
      expect((yield* restored.next()).value).toBe("parent");
    });
    await task.result;
    expect(observed.slice(0, 2).sort()).toEqual(["left", "right"]);
    expect(observed.slice(2)).toEqual(["parent", "parent"]);
  });

  it(`${runtime.name}: one program binding resolves sibling scoped drivers and restores its parent`, async () => {
    function driver(label: string) {
      return {
        *resolve(
          invocation: ProgramInvocation<string>,
        ): Operation<ResolvedProgram<string, never, Y>, Y> {
          return {
            program: invocation.program,
            *acquire() {
              return createScopedGuest(function* () {
                return `${label}:${invocation.input}`;
              });
            },
          };
        },
      };
    }
    const resolver = createProgramResolver(runtime.composition, "programs", driver("parent"));
    const bound = createProgramExecution({
      invocation: { program: "pinned", input: "input" },
      resolve: resolver.operations.resolve,
    });
    const task = start(function* () {
      const values = yield* runtime.all(
        ["left", "right"].map(
          (label) =>
            function* () {
              return yield* runtime.composition.scoped(function* () {
                yield* resolver.install(driver(label));
                const guest = yield* bound.acquire();
                yield* runtime.composition.ensure(() => guest.close());
                return yield* guest.start();
              });
            },
        ),
      );
      expect(values).toEqual([
        { kind: "completed", value: "left:input" },
        { kind: "completed", value: "right:input" },
      ]);
      const guest = yield* bound.acquire();
      yield* runtime.composition.ensure(() => guest.close());
      expect(yield* guest.start()).toEqual({ kind: "completed", value: "parent:input" });
    });
    await task.result;
  });

  it(`${runtime.name}: admission policies isolate concurrent callers and denial precedes schema or storage`, async () => {
    let validations = 0;
    const tool = {
      id: "admitted",
      context: z.string().transform((value) => {
        validations++;
        return value.trim();
      }),
    };
    const store = createSqliteJournalRig<unknown, unknown, unknown, string, unknown, Y>({
      program: tool.id,
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const journal = store.open();
    const admission = createToolAdmission(runtime, "admission", tool, journal);
    const allowed = runtime.composition.createContext<boolean>("allowed");
    const task = start(function* () {
      yield* allowed.set(false);
      yield* admission.around({
        *admit([input], next) {
          if (!(yield* allowed.expect())) {
            throw new Error("Admission denied");
          }
          return yield* next(input);
        },
      });
      yield* runtime.composition.catchError(
        () => admission.operations.admit("input"),
        function* (error) {
          expect(String(error)).toContain("Admission denied");
          return "denied";
        },
      );
      expect(validations).toBe(0);
      expect((yield* journal.read()).admission).toBeUndefined();
      const result = yield* runtime.all(
        [false, true].map(
          (permission) =>
            function* () {
              return yield* runtime.composition.scoped(function* () {
                yield* allowed.set(permission);
                return yield* runtime.composition.catchError(
                  () => admission.operations.admit(" input "),
                  function* () {
                    return "denied";
                  },
                );
              });
            },
        ),
      );
      expect(result).toEqual(["denied", "input"]);
      expect(validations).toBe(1);
      expect(yield* allowed.expect()).toBe(false);
    });
    await task.result;
    store.reopen();
    const read = start(() => store.open().read());
    expect((await read.result).admission?.input).toBe("input");
    expect(validations).toBe(1);
  });

  it(`${runtime.name}: response source/cursor policy is scoped and cannot retarget an existing reader`, async () => {
    const sources = new Map<string, BufferedSignal<string, string, Y>>();
    for (const name of ["a", "b"]) {
      const source = createBufferedSignal<string, string, Y>(runtime);
      source.send(name);
      source.close("done");
      sources.set(name, source);
    }
    const selected = runtime.composition.createContext<string>("output-source");
    const access = runtime.composition.createContext<boolean>("output-access");
    let subscriptions = 0;
    const outputs = createResponseSubscriptions(runtime.composition, "outputs", {
      *subscribe(cursor: { source: string; after: number }) {
        const name = yield* selected.expect();
        if (cursor.source !== name) {
          throw new Error("Cursor belongs to another source");
        }
        subscriptions++;
        return yield* sources.get(name)!.from(cursor.after);
      },
    });
    const task = start(function* () {
      yield* selected.set("a");
      yield* access.set(false);
      yield* outputs.around({
        *subscribe(args, next) {
          if (!(yield* access.expect())) {
            throw new Error("Output denied");
          }
          return yield* next(...args);
        },
      });
      yield* runtime.composition.catchError(
        function* () {
          yield* outputs.operations.subscribe({ source: "a", after: 0 });
        },
        function* (error) {
          expect(String(error)).toContain("Output denied");
        },
      );
      expect(subscriptions).toBe(0);
      yield* runtime.composition.scoped(function* () {
        yield* access.set(true);
        const parent = yield* outputs.operations.subscribe({ source: "a", after: 0 });
        const values = yield* runtime.all(
          ["a", "b"].map(
            (name) =>
              function* () {
                return yield* runtime.composition.scoped(function* () {
                  yield* selected.set(name);
                  const reader = yield* outputs.operations.subscribe({ source: name, after: 0 });
                  return (yield* reader.next()).value;
                });
              },
          ),
        );
        expect(values).toEqual(["a", "b"]);
        expect((yield* parent.next()).value).toBe("a");
        yield* runtime.composition.catchError(
          function* () {
            yield* outputs.operations.subscribe({ source: "b", after: 0 });
          },
          function* (error) {
            expect(String(error)).toContain("another source");
          },
        );
      });
      expect(yield* access.expect()).toBe(false);
    });
    await task.result;
    expect(subscriptions).toBe(3);
  });

  it(`${runtime.name}: client handler replacement restores after scope exit and pending UI cancels independently`, async () => {
    const peer = createProtocolRig();
    const handler = createElicitationHandler<string, string, string, Y>(
      runtime.composition,
      "client-handler",
      {
        *handle(context) {
          return { ok: true as const, value: `parent:${context}` };
        },
      },
    );
    const task = start(function* () {
      const values = yield* runtime.all(
        ["left", "right"].map(
          (label) =>
            function* () {
              return yield* runtime.composition.scoped(function* () {
                yield* handler.install({
                  *handle(context) {
                    return { ok: true as const, value: `${label}:${context}` };
                  },
                });
                return yield* handler.operations.handle("question");
              });
            },
        ),
      );
      expect(values).toEqual([
        { ok: true, value: "left:question" },
        { ok: true, value: "right:question" },
      ]);
      expect(yield* handler.operations.handle("question")).toEqual({
        ok: true,
        value: "parent:question",
      });
    });
    await task.result;
    const pending = start(function* () {
      yield* handler.install({
        *handle(context) {
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: "ui", token: context }, signal),
          );
          return { ok: true as const, value: reply.body };
        },
      });
      return yield* handler.operations.handle("question");
    });
    await Promise.race([peer.waitForRequests(1), pending.result]);
    await pending.cancel();
    expect(peer.aborted).toEqual(["ui"]);
    expect(await start(() => handler.operations.handle("question")).result).toEqual({
      ok: true,
      value: "parent:question",
    });
  });

  it(`${runtime.name}: notification driver replacement keeps each grant signal and subscription owner isolated`, async () => {
    const a = createNotificationRig();
    const b = createNotificationRig();
    function driver(peer: typeof a) {
      return {
        *subscribe(grant: { attemptId: string }) {
          const subscription = peer.subscribe(grant.attemptId);
          yield* runtime.composition.ensure(function* () {
            subscription.close();
          });
          return subscription.signal;
        },
        *publish(grant: { attemptId: string }) {
          peer.publish(grant.attemptId);
        },
      };
    }
    const notifications = createAttemptNotifications(
      runtime.composition,
      "notifications",
      driver(a),
    );
    const grant = { requestId: "request", attemptId: "attempt", retrySafety: "unsafe" as const };
    const task = start(function* () {
      const parent = yield* notifications.operations.subscribe(grant);
      yield* runtime.composition.scoped(function* () {
        yield* notifications.install(driver(b));
        const child = yield* notifications.operations.subscribe(grant);
        yield* notifications.operations.publish(grant);
        expect(child.aborted).toBe(true);
        expect(parent.aborted).toBe(false);
      });
      expect(b.subscriptions).toBe(0);
      expect(a.subscriptions).toBe(1);
      yield* notifications.operations.publish(grant);
      expect(parent.aborted).toBe(true);
    });
    await task.result;
    expect(a.subscriptions).toBe(0);
  });

  it(`${runtime.name}: a nested tool catalog denies routing before child creation and restores the parent`, async () => {
    let validations = 0;
    let runs = 0;
    const tool = defineEffect({
      key: "scoped-route",
      context: z.string().transform((value) => {
        validations++;
        return value.trim();
      }),
      response: z.string(),
    });
    const effects = createEffectCapabilities(runtime, "routing-effects");
    const parent = effects.grant({ tool });
    const restricted = effects.grant({});
    const catalog = runtime.composition.createContext<typeof parent.admission>("tool-catalog");
    const store = createSqliteJournalRig<unknown, CapabilityRequest, unknown, string, unknown, Y>({
      program: "routing-parent",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const journal = store.open();
    const recovery = createRecovery<unknown, CapabilityRequest, Y, unknown, string>(runtime, {
      name: "routing-recovery",
      program: "routing-parent",
      matches: isDeepStrictEqual,
      *acquire() {
        return createScopedGuest(function* () {
          return yield* parent.capabilities.tool(" input ");
        });
      },
    });
    const host = createHosting(runtime.composition, {
      name: "routing-host",
      journal,
      recovery: recovery.operations,
      attempts: journal.attempts,
      handle: parent.handle,
    });
    await start(function* () {
      yield* catalog.set(parent.admission);
      yield* host.around({
        *child(args, next) {
          const admission = yield* catalog.expect();
          return yield* admission.child(args, next);
        },
      });
      yield* installToolRouting(runtime, host, journal, {
        tool,
        *run(child) {
          runs++;
          expect(child.link.input).toBe("input");
          return false;
        },
      });
      yield* runtime.composition.scoped(function* () {
        yield* catalog.set(restricted.admission);
        let denied = false;
        yield* runtime.composition.catchError(
          () => host.operations.run(),
          function* () {
            denied = true;
          },
        );
        expect(denied).toBe(true);
        expect(validations).toBe(0);
        expect(runs).toBe(0);
        const snapshot = yield* journal.read();
        expect(snapshot.status === "running" ? snapshot.children : undefined).toBeUndefined();
      });
      expect((yield* host.operations.run()).state).toBe("child");
      expect(validations).toBe(1);
      expect(runs).toBe(1);
      expect((yield* host.operations.run()).state).toBe("child");
      expect(validations).toBe(1);
    }).result;
  });

  it(`${runtime.name}: counting sees the full prepared request and over-budget requests never reach the provider`, async () => {
    const model: ModelInfo = {
      id: "tiny",
      name: "Tiny",
      provider: "test",
      api: "test",
      input: ["text"],
      output: ["text"],
      contextWindow: 16,
      maxOutputTokens: 8,
      reasoningLevels: [],
    };
    let dispatches = 0;
    const request = {
      context: {
        messages: [{ role: "user" as const, content: "Long question" }],
        tools: [{ name: "tool", description: null, parameters: { type: "object" } }],
      },
    };
    const counter = createContextCounter(runtime.composition, "counter", {
      *count(_model, input) {
        expect(input).toEqual(request);
        return { tokens: JSON.stringify(input).length, kind: "estimated" as const };
      },
    });
    const provider = createModelProvider<Y, typeof request, never, string>(
      runtime.composition,
      "bounded-provider",
      {
        *stream() {
          dispatches++;
          const source = createBufferedSignal<never, string, Y>(runtime);
          source.close("done");
          return yield* source.from(0);
        },
      },
    );
    const task = start(function* () {
      const count = yield* counter.operations.count(model, request);
      expect(count.kind).toBe("estimated");
      if (measureContextBudget(model, count, 8).fits !== true) {
        throw new Error("Over budget");
      }
      return yield* provider.operations.stream(request);
    });
    await expect(task.result).rejects.toThrow("Over budget");
    expect(dispatches).toBe(0);
  });
});
