import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { readJournal, createHostedExecution } from "@sweatpan.ts/testing";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Context, Outcome } from "@standard-durability/core";
import {
  createRecovery,
  createCheckpointMiddleware,
  type AttemptGrant,
} from "@sweatpan.ts/durable";
import {
  createHosting,
  installGuestRetention,
  createEffectCapabilities,
  type HostedResult,
} from "@sweatpan.ts/hosting";
import {
  createLuaEvaluator,
  defineLuaEffectBindings,
  luaWasmUrl,
} from "@sweatpan.ts/codemode-runtime-lua";
import { createProtocolRig, createSqliteJournalRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

let compiled: Promise<WebAssembly.Module> | undefined;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected record");
  }
  return value as Record<string, unknown>;
}
function decodeResult(value: unknown) {
  const result = record(value);
  if (typeof result.hold !== "string" || typeof result.approval !== "string") {
    throw new Error("Expected booking result");
  }
  return { hold: result.hold, approval: result.approval };
}
function textSchema<T>(transform: (input: string) => T): StandardSchemaV1<string, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "lua-acceptance",
      validate(input) {
        return typeof input === "string"
          ? { value: transform(input) }
          : { issues: [{ message: "Expected text" }] };
      },
    },
  };
}
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const lifetime of ["recover", "retain"] as const) {
    for (const mode of ["replay", "restore", "fallback"] as const) {
      const checkpoints = mode !== "replay";
      it(`${runtime.name} ${lifetime}: reopens named Lua effects through grants after acceptance with fresh delivery scopes (${mode})`, async () => {
        const store = createSqliteJournalRig<
          ReturnType<typeof decodeResult>,
          CapabilityRequest,
          unknown,
          string,
          unknown,
          Y
        >({ program: "booking", equals: isDeepStrictEqual });
        onTestFinished(() => store.close());
        const peer = createProtocolRig();
        const grants: AttemptGrant[] = [];
        const finalized: string[] = [];
        let contextParses = 0;
        let responseParses = 0;
        let handlerMiddleware = 0;
        let admissions = 0;
        let commands = 0;
        let starts = 0;
        let resumes = 0;
        let restores = 0;
        const ranges: { from: number; end: number }[] = [];
        function run(stopAfterFirst = false) {
          const stored = store.open();
          const journal: typeof stored = {
            ...stored,
            *read() {
              const snapshot = yield* stored.read();
              return {
                ...snapshot,
                history: {
                  ...snapshot.history,
                  *read(from, limit) {
                    ranges.push({ from, end: snapshot.history.end.position });
                    return yield* snapshot.history.read(from, limit);
                  },
                },
              };
            },
          };
          const evaluator = createLuaEvaluator(runtime, {
            source: `
local hold = workflow.effect("reserve", { effect = "reserve", input = "reserve" })
assert(hold.ok)
local approval = workflow.effect("approve", { effect = "approve", input = hold.value.text })
assert(not approval.ok)
return { hold = hold.value.text, approval = approval.error.code }
`,
            input: null,
            decodeRequest: (value) => bindings.decodeRequest(value),
            decodeResult,
            loadModule() {
              commands++;
              return (compiled ??= readFile(luaWasmUrl).then((bytes) =>
                WebAssembly.compile(bytes),
              ));
            },
          });
          const placement = createHostedExecution(runtime, evaluator);
          const checkpointAdapter = placement.checkpoints;
          if (!checkpointAdapter) {
            throw new Error("Expected checkpoint capability");
          }
          const recovery = createRecovery(runtime.composition, {
            name: "booking-recovery",
            program: "booking",
            matches: isDeepStrictEqual,
            acquire: placement.acquire,
          });
          const attempts: typeof journal.attempts = {
            begin: journal.attempts.begin,
            *settle(grant, outcome) {
              const accepted = yield* journal.attempts.settle(grant, outcome);
              if (stopAfterFirst) {
                throw new Error("Host stopped after accepted reservation");
              }
              return accepted;
            },
          };
          // Break the assembly type cycle without annotating authored handler results.
          let delivery: Context<AttemptGrant, Y>;
          const effects = createEffectCapabilities(runtime, "lua-effects");
          function declaration(binding: string) {
            return defineEffect(
              {
                key: `booking:${binding}`,
                context: textSchema((hold) => {
                  contextParses++;
                  return { binding, hold };
                }),
                response: textSchema((text) => {
                  responseParses++;
                  return { text };
                }),
              },
              function* (input) {
                const grant = yield* delivery.expect();
                const snapshot = yield* journal.read();
                expect(snapshot.frontier.position).toBe(grants.length);
                expect(snapshot.checkpoint?.position).toBe(checkpoints ? grants.length : undefined);
                if (grants.length) {
                  expect(finalized).toEqual([grants[0]!.attemptId]);
                  expect(grant.requestId).not.toBe(grants[0]!.requestId);
                  expect(grant.attemptId).not.toBe(grants[0]!.attemptId);
                  expect(input.hold).toBe("hold-9");
                }
                grants.push(grant);
                yield* runtime.composition.ensure(function* () {
                  expect(yield* delivery.expect()).toEqual(grant);
                  finalized.push(grant.attemptId);
                });
                const reply = yield* runtime.fromPromise((signal) =>
                  peer.send({ id: input.binding, token: grant.requestId }, signal),
                );
                return input.binding === "approve"
                  ? { ok: false, error: { code: reply.body } }
                  : { ok: true, value: reply.body };
              },
            );
          }
          const reserve = declaration("reserve");
          const approve = declaration("approve");
          const bindings = defineLuaEffectBindings({ reserve, approve });
          const ctx = effects.grant({ reserve, approve });
          const host = createHosting(runtime.composition, {
            name: "booking-host",
            recovery: recovery.operations,
            journal,
            attempts,
            handle: ctx.handle,
          });
          delivery = host.delivery;
          const execution = runtime.start(function* () {
            yield* host.around(ctx.admission);
            if (lifetime === "retain") {
              yield* installGuestRetention(runtime.composition, host, recovery, journal);
            }
            yield* host.around({
              *child([pending], next) {
                admissions++;
                return yield* next(pending);
              },
            });
            yield* effects.install(reserve);
            yield* effects.install(approve);
            for (const definition of [reserve, approve]) {
              yield* effects.api(definition).around({
                *handle([input], next) {
                  handlerMiddleware++;
                  expectTypeOf(input).toEqualTypeOf<{ binding: string; hold: string }>();
                  return yield* next(input);
                },
              });
            }
            yield* recovery.execution.around({
              *start(args, next) {
                starts++;
                return yield* next(...args);
              },
              *resume([outcome], next) {
                resumes++;
                expectTypeOf(outcome).toEqualTypeOf<Outcome<unknown, unknown>>();
                return yield* next(outcome);
              },
            });
            if (checkpoints) {
              yield* recovery.around(
                createCheckpointMiddleware({
                  execution: recovery.execution,
                  program: "booking",
                  adapter: {
                    ...checkpointAdapter,
                    // Simulate a checkpoint format retired between host assemblies.
                    format:
                      stopAfterFirst && mode === "fallback"
                        ? "retired-lua-format"
                        : checkpointAdapter.format,
                    *restore(state) {
                      restores++;
                      return yield* checkpointAdapter.restore(state);
                    },
                  },
                  matches: isDeepStrictEqual,
                }),
              );
            }
            expect(yield* host.delivery.get()).toBeUndefined();
            const result = yield* host.operations.run();
            expect(yield* host.delivery.get()).toBeUndefined();
            const completedCommands = commands;
            expect(yield* host.operations.run()).toEqual(result);
            expect(commands).toBe(completedCommands);
            return result;
          });
          void execution.result.catch(() => undefined);
          onTestFinished(() => execution.cancel());
          return execution;
        }
        const first = run(true);
        await Promise.race([peer.waitForRequests(1), first.result]);
        peer.reply("reserve", { status: 200, body: "hold-9" });
        await expect(first.result).rejects.toThrow("Host stopped after accepted reservation");
        expect(finalized).toEqual([grants[0]!.attemptId]);
        const inspect = runtime.start(() => readJournal(store.open()));
        onTestFinished(() => inspect.cancel());
        const saved = await inspect.result;
        expect(saved.history).toHaveLength(1);
        expect(saved.checkpoint?.position).toBe(checkpoints ? 0 : undefined);
        expect(saved.history[0]!.outcome).toEqual({
          ok: true,
          value: { ok: true, value: { text: "hold-9" } },
        });
        // No evaluator, recovery API, host or journal handle is reused by run().
        store.reopen();
        const execution = run();
        await Promise.race([peer.waitForRequests(2), execution.result]);
        peer.reply("approve", { status: 200, body: "declined" });
        const result = await execution.result;
        expectTypeOf(result).toEqualTypeOf<
          HostedResult<{ hold: string; approval: string }, CapabilityRequest>
        >();
        expect(result).toEqual({
          state: "completed",
          value: { hold: "hold-9", approval: "declined" },
        });
        expect({ contextParses, responseParses, handlerMiddleware, admissions }).toEqual({
          contextParses: 2,
          responseParses: 1,
          handlerMiddleware: 2,
          admissions: 2,
        });
        expect(finalized).toEqual(grants.map((grant) => grant.attemptId));
        expect(commands).toBe(lifetime === "retain" ? 4 : checkpoints ? 5 : 6);
        expect(starts).toBe(
          mode === "restore" ? 1 : lifetime === "retain" || mode === "fallback" ? 2 : 3,
        );
        expect(restores).toBe(
          lifetime === "retain"
            ? mode === "restore"
              ? 1
              : 0
            : mode === "restore"
              ? 2
              : mode === "fallback"
                ? 1
                : 0,
        );
        expect(resumes).toBe(lifetime === "retain" || checkpoints ? 2 : 3);
        expect(ranges).toEqual([
          { from: 0, end: 1 },
          { from: lifetime === "retain" || checkpoints ? 1 : 0, end: 2 },
        ]);
        expect(peer.requests.map((request) => request.id)).toEqual(["reserve", "approve"]);
      });
    }
  }
});
