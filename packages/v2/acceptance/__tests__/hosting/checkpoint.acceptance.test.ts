import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Outcome } from "@standard-durability/core";
import {
  createRecovery,
  createCheckpointMiddleware,
  type AttemptGrant,
} from "@sweatpan.ts/durable";
import { createHosting, type HostedResult } from "@sweatpan.ts/hosting";
import { createMemoryJournalStore } from "@sweatpan.ts/storage-memory";
import { createLuaEvaluator, luaWasmUrl } from "@sweatpan.ts/codemode-runtime-lua";
import { createProtocolRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

let compiled: Promise<WebAssembly.Module> | undefined;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected record");
  }
  return value as Record<string, unknown>;
}
function decodeRequest(value: unknown) {
  const request = record(record(value).request);
  if (typeof request.binding !== "string") {
    throw new Error("Expected binding");
  }
  return { binding: request.binding, hold: request.hold };
}
function decodeResult(value: unknown) {
  const result = record(value);
  if (typeof result.hold !== "string" || typeof result.approval !== "string") {
    throw new Error("Expected booking result");
  }
  return { hold: result.hold, approval: result.approval };
}
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const mode of ["replay", "restore", "fallback"] as const) {
    const checkpoints = mode !== "replay";
    it(`${runtime.name}: reopens Lua hosting after acceptance with fresh delivery scopes (${mode})`, async () => {
      const store = createMemoryJournalStore<
        ReturnType<typeof decodeResult>,
        ReturnType<typeof decodeRequest>,
        string,
        string
      >({ program: "booking", equals: isDeepStrictEqual });
      const peer = createProtocolRig();
      const grants: AttemptGrant[] = [];
      const finalized: string[] = [];
      let commands = 0;
      let starts = 0;
      let resumes = 0;
      let restores = 0;
      function run(stopAfterFirst = false) {
        const journal = store.open();
        const evaluator = createLuaEvaluator(runtime, {
          source: `
local hold = workflow.effect("reserve", { binding = "reserve" })
local approval = workflow.effect("approve", { binding = "approve", hold = hold })
return { hold = hold, approval = approval }
`,
          input: null,
          decodeRequest,
          decodeResult,
          loadModule() {
            commands++;
            return (compiled ??= readFile(luaWasmUrl).then((bytes) => WebAssembly.compile(bytes)));
          },
        });
        const recovery = createRecovery(runtime.composition, {
          name: "booking-recovery",
          program: "booking",
          matches: isDeepStrictEqual,
          acquire: evaluator.acquire,
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
        const host = createHosting(runtime.composition, {
          name: "booking-host",
          recovery: recovery.operations,
          journal,
          attempts,
          *handle(request): Operation<Outcome<string, string>, Y> {
            const grant = yield* host.delivery.expect();
            const snapshot = yield* journal.read();
            expect(snapshot.history).toHaveLength(grants.length);
            expect(snapshot.checkpoint?.position).toBe(checkpoints ? grants.length : undefined);
            if (grants.length) {
              expect(finalized).toEqual([grants[0]!.attemptId]);
              expect(grant.requestId).not.toBe(grants[0]!.requestId);
              expect(grant.attemptId).not.toBe(grants[0]!.attemptId);
              expect(request.hold).toBe("hold-9");
            }
            grants.push(grant);
            yield* runtime.composition.ensure(function* () {
              expect(yield* host.delivery.expect()).toEqual(grant);
              finalized.push(grant.attemptId);
            });
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send({ id: request.binding, token: grant.requestId }, signal),
            );
            return { ok: true, value: reply.body };
          },
        });
        const execution = runtime.start(function* () {
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
                  ...evaluator.checkpoints,
                  // Simulate a checkpoint format retired between host assemblies.
                  format:
                    stopAfterFirst && mode === "fallback"
                      ? "retired-lua-format"
                      : evaluator.checkpoints.format,
                  *restore(state) {
                    restores++;
                    return yield* evaluator.checkpoints.restore(state);
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
      const inspect = runtime.start(() => store.open().read());
      onTestFinished(() => inspect.cancel());
      const saved = await inspect.result;
      expect(saved.history).toHaveLength(1);
      expect(saved.checkpoint?.position).toBe(checkpoints ? 0 : undefined);
      expect(saved.history[0]!.outcome).toEqual({ ok: true, value: "hold-9" });
      // No evaluator, recovery API, host or journal handle is reused by run().
      const execution = run();
      await Promise.race([peer.waitForRequests(2), execution.result]);
      peer.reply("approve", { status: 200, body: "approved" });
      const result = await execution.result;
      expectTypeOf(result).toEqualTypeOf<
        HostedResult<{ hold: string; approval: string }, ReturnType<typeof decodeRequest>>
      >();
      expect(result).toEqual({
        state: "completed",
        value: { hold: "hold-9", approval: "approved" },
      });
      expect(finalized).toEqual(grants.map((grant) => grant.attemptId));
      expect(commands).toBe(checkpoints ? 5 : 6);
      expect(starts).toBe(mode === "restore" ? 1 : mode === "fallback" ? 2 : 3);
      expect(restores).toBe(mode === "restore" ? 2 : mode === "fallback" ? 1 : 0);
      expect(resumes).toBe(checkpoints ? 2 : 3);
      expect(peer.requests.map((request) => request.id)).toEqual(["reserve", "approve"]);
    });
  }
});
