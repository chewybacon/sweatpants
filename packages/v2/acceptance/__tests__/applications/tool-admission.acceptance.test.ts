import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Work } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createRecovery } from "@sweatpan.ts/durable";
import {
  createEffectCapabilities,
  createHosting,
  installEffectAnswers,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import {
  createToolAdmission,
  createToolAcquisition,
  admitTool,
  defineTool,
  installElicitHandlers,
} from "@sweatpan.ts/tools";
import { createLatch, createProtocolRig, createSqliteJournalRig } from "@sweatpan.ts/testing";
import { createMemoryJournalStore } from "@sweatpan.ts/storage-memory";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

function textSchema<T>(transform: (value: string) => T): StandardSchemaV1<string, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "tool-admission",
      validate(value) {
        return typeof value === "string" && value.trim()
          ? { value: transform(value) }
          : { issues: [{ message: "Expected nonempty text" }] };
      },
    },
  };
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution;
  }

  for (const automatic of [false, true]) {
    for (const storage of ["memory", "sqlite"] as const) {
      it(`${runtime.name}: ${storage} ${automatic ? "automatic" : "participant"} root tool admission pins transformed input through recording, answers and reopen`, async () => {
        let validations = 0;
        let acquisitions = 0;
        let calls = 0;
        let handlerCalls = 0;
        let responseParses = 0;
        const peer = createProtocolRig();
        const question = defineEffect({
          key: "admitted.question",
          context: textSchema((value) => ({ question: value })),
          response: textSchema((value) => {
            responseParses++;
            return value === "yes";
          }),
        });
        const tool = defineTool("admitted-tool")
          .parameters(
            textSchema((value) => {
              validations++;
              return { query: value.trim().toLowerCase() };
            }),
          )
          .elicits({ question })
          .execute(function* (input, ctx) {
            const text = yield* ctx.await(
              async (signal) => {
                calls++;
                const reply = await peer.send({ id: input.query, token: "read" }, signal);
                return reply.body;
              },
              { record: { key: "read" } },
            );
            const answer = yield* ctx.elicit("question", input.query);
            if (!answer.ok) {
              throw new Error("Authored refusal");
            }
            return { text, approved: answer.value };
          });
        type Input = StandardSchemaV1.InferOutput<typeof tool.context>;
        type Result = { text: string; approved: boolean };
        const options = { program: tool.id, equals: isDeepStrictEqual };
        const store =
          storage === "sqlite"
            ? createSqliteJournalRig<Result, CapabilityRequest, unknown, string, unknown, Y>(
                options,
              )
            : (() => {
                const memory = createMemoryJournalStore<Result, CapabilityRequest, unknown, string>(
                  options,
                );
                return { open: () => memory.open(), reopen: () => memory.open(), close() {} };
              })();
        onTestFinished(() => store.close());
        // One ingress policy identity; the command binding follows reopened storage.
        const admission = createToolAdmission(runtime, "root-admission", tool, {
          admit: (program, input) => store.open().admit(program, input),
        });
        function submit(input: string) {
          return start(() => admission.operations.admit(input)).result;
        }
        await expect(submit("")).rejects.toThrow("Tool input schema rejected value");
        expect((await start(() => store.open().read()).result).admission).toBeUndefined();
        expect(acquisitions).toBe(0);
        const admitted = await submit(" AUTH ");
        expectTypeOf(admitted).toEqualTypeOf<Input>();
        expect(admitted).toEqual({ query: "auth" });
        admitted.query = "mutated outside storage";
        await expect(submit("auth")).resolves.toEqual({ query: "auth" });
        await expect(submit("different")).rejects.toThrow("Conflicting invocation input");
        await expect(
          start(() => store.open().admit("wrong-program", { query: "auth" })).result,
        ).rejects.toThrow("Admission program mismatch");
        const admittedValidations = validations;
        expect(acquisitions).toBe(0);
        store.reopen(); // Admission survives even before the first Guest exists.

        function assemble() {
          const journal = store.open();
          const effects = createEffectCapabilities(runtime, "admitted-effects");
          const acquisition = createToolAcquisition(runtime, effects, tool, "admitted-acquisition");
          const recovery = createRecovery(runtime.composition, {
            name: "admitted-recovery",
            program: tool.id,
            matches: isDeepStrictEqual,
            *acquire() {
              const snapshot = yield* journal.read();
              if (!snapshot.admission) {
                throw new Error("Tool invocation has not been admitted");
              }
              // Trusted persisted output for this pinned program, not another parse boundary.
              const input = snapshot.admission.input as Input;
              acquisitions++;
              return yield* acquisition.operations.acquire(input);
            },
          });
          const host = createHosting(runtime.composition, {
            name: "admitted-host",
            journal,
            recovery: recovery.operations,
            attempts: journal.attempts,
            interactions: journal.interactions,
            handle: acquisition.handle,
          });
          return {
            run() {
              return start(function* () {
                yield* host.around(acquisition.admission);
                // Outer scope parks all declared elicits; an inner scope may override it.
                yield* installElicitHandlers(host, effects, tool);
                yield* installGuestRetention(runtime.composition, host, recovery, journal);
                if (automatic) {
                  const result = yield* runtime.composition.scoped(function* () {
                    yield* installElicitHandlers(host, effects, tool, {
                      *question(context) {
                        expectTypeOf(context).toEqualTypeOf<{ question: string }>();
                        expect(context).toEqual({ question: "auth" });
                        handlerCalls++;
                        return { ok: true, value: "yes" };
                      },
                    });
                    yield* effects.api(question).around({
                      *handle([context], next) {
                        return yield* next(context);
                      },
                    });
                    return yield* host.operations.run();
                  });
                  expect(
                    yield* host.operations.deliveryMode({ effect: question.id, input: "auth" }),
                  ).toBe("wait");
                  return result;
                }
                return yield* host.operations.run();
              }).result;
            },
            answer(grant: Parameters<typeof journal.interactions.request>[0]) {
              return start(function* () {
                const answers = yield* installEffectAnswers(
                  host,
                  effects.grant(tool.elicits),
                  journal.interactions,
                );
                return yield* answers.answer(grant, { ok: true, value: "yes" });
              }).result;
            },
          };
        }
        const first = assemble().run();
        await Promise.race([peer.waitForRequests(1), first]);
        peer.reply("auth", { status: 200, body: "source text" });
        const result = await first;
        const completed = { state: "completed", value: { text: "source text", approved: true } };
        if (automatic) {
          expect(result).toEqual(completed);
        } else {
          if (result.state !== "waiting") {
            throw new Error("Expected elicitation");
          }
          store.reopen();
          const resumed = assemble();
          await expect(resumed.run()).resolves.toEqual(result);
          await resumed.answer(result.grant);
          store.reopen();
          await expect(assemble().run()).resolves.toEqual(completed);
        }
        store.reopen();
        await expect(assemble().run()).resolves.toEqual(completed);
        expect(handlerCalls).toBe(automatic ? 1 : 0);
        expect(responseParses).toBe(1);
        expect({ calls, validations }).toEqual({ calls: 1, validations: admittedValidations });
        expect((await start(() => store.open().read()).result).admission).toEqual({
          input: { query: "auth" },
        });
        await expect(submit("auth")).resolves.toEqual({ query: "auth" });
        await expect(submit("different")).rejects.toThrow("Conflicting invocation input");
      });
    }
  }

  it(`${runtime.name}: concurrent root admission selects one normalized input across SQLite connections`, async () => {
    const store = createSqliteJournalRig<unknown, CapabilityRequest, unknown, string, unknown, Y>({
      program: "admission-race",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const ready = createLatch<void>();
    const release = createLatch<void>();
    let validations = 0;
    const schema: StandardSchemaV1<string, { text: string }> = {
      "~standard": {
        version: 1,
        vendor: "race",
        async validate(value) {
          if (typeof value !== "string") {
            return { issues: [{ message: "Expected text" }] };
          }
          validations++;
          if (value === "late") {
            ready.resolve();
            await release.promise;
          }
          return { value: { text: value } };
        },
      },
    };
    const tool = defineTool("admission-race")
      .parameters(schema)
      .execute(function* (input) {
        return input;
      });
    const late = start(() => admitTool(runtime, tool, store.open(), "late"));
    await ready.promise;
    await expect(
      start(() => admitTool(runtime, tool, store.connect(), "winner")).result,
    ).resolves.toEqual({ text: "winner" });
    release.resolve();
    await expect(late.result).rejects.toThrow("Conflicting invocation input");
    store.reopen();
    expect((await start(() => store.open().read()).result).admission).toEqual({
      input: { text: "winner" },
    });
    expect(validations).toBe(2);
  });
});
