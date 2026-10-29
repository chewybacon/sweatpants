import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation, Work } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createRecovery, type OwnedChild, type ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest, type Guest } from "@sweatpan.ts/execution";
import {
  createEffectCapabilities,
  createHosting,
  installEffectAnswers,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import { defineTool } from "@sweatpan.ts/tools";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createProtocolRig, createSqliteJournalRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

function textSchema<T>(transform: (text: string) => T): StandardSchemaV1<string, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "tool-prototype",
      validate(value) {
        return typeof value === "string"
          ? { value: transform(value) }
          : { issues: [{ message: "Expected text" }] };
      },
    },
  };
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const recording of ["generator", "promise", "promise-rejected"] as const) {
    for (const placement of ["local", "wrapped"] as const) {
      it(`${runtime.name}: ${placement} tool ${recording} records, elicits and settles its owned invocation after reopen`, async () => {
        const peer = createProtocolRig();
        let records = 0;
        let reads = 0;
        let inputs = 0;
        let responses = 0;
        let acquisitions = 0;
        let disposals = 0;
        let placements = 0;
        let projections = 0;
        let cleanups = 0;
        const readFile = defineEffect(
          { key: "read-file", context: textSchema((path) => ({ path })) },
          function* ({ path }) {
            reads++;
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send({ id: path, token: "read" }, signal),
            );
            return { ok: true as const, value: { contents: reply.body } };
          },
        );
        const clarification = defineEffect({
          key: "investigate.clarification",
          context: textSchema((question) => ({ question })),
          response: textSchema((answer) => {
            responses++;
            return { approved: answer === "yes" };
          }),
        });
        const investigate = defineTool("investigate")
          .parameters(
            textSchema((query) => {
              inputs++;
              return { query: query.toLowerCase() };
            }),
          )
          .capabilities({ readFile })
          .elicits({ clarification })
          .execute(function* (input, ctx) {
            yield* ctx.scope.ensure(function* () {
              cleanups++;
            });
            expectTypeOf(input).toEqualTypeOf<{ query: string }>();
            let label: string;
            if (recording === "generator") {
              const recorded = yield* ctx.record(function* () {
                records++;
                return { ok: true as const, value: { label: `investigation-${records}` } };
              });
              expectTypeOf(recorded.value).toEqualTypeOf<{ label: string }>();
              label = recorded.value.label;
            } else {
              const recorded = yield* ctx.await(
                async (signal) => {
                  expect(signal.aborted).toBe(false);
                  records++;
                  if (recording === "promise-rejected") {
                    throw new Error("Recorded Promise delivery failed");
                  }
                  return { label: `investigation-${records}` };
                },
                { record: placement === "wrapped" ? {} : { key: "investigation-label" } },
              );
              expectTypeOf(recorded).toEqualTypeOf<{ label: string }>();
              label = recorded.label;
            }
            const file = yield* ctx.capabilities.readFile(input.query);
            if (!file.ok) {
              throw new Error("Read failed");
            }
            expectTypeOf(file.value).toEqualTypeOf<{ contents: string }>();
            const answer = yield* ctx.elicit("clarification", `Include ${input.query}?`);
            if (!answer.ok) {
              throw new Error("Clarification failed");
            }
            expectTypeOf(answer.value).toEqualTypeOf<{ approved: boolean }>();
            return {
              label,
              contents: file.value.contents,
              approved: answer.value.approved,
            };
          });
        type Result =
          ReturnType<typeof investigate.body> extends Operation<infer R, unknown> ? R : never;
        type Input = StandardSchemaV1.InferOutput<typeof investigate.context>;
        type Child = OwnedChild<Result, CapabilityRequest, unknown, string, unknown, Y>;
        expectTypeOf<Result>().toEqualTypeOf<{
          label: string;
          contents: string;
          approved: boolean;
        }>();
        const store = createSqliteJournalRig<
          Result,
          CapabilityRequest,
          unknown,
          string,
          unknown,
          Y
        >({
          program: "tool-caller",
          equals: isDeepStrictEqual,
        });
        onTestFinished(() => store.close());
        function start<T>(work: Work<T, Y>) {
          const execution = runtime.start(work);
          void execution.result.catch(() => undefined);
          onTestFinished(() => execution.cancel());
          return execution;
        }
        function assemble() {
          const journal = store.open();
          const effects = createEffectCapabilities(runtime, "tool-prototype");
          const caller = effects.grant({ investigate });
          function freshGrant() {
            return effects.grant({ readFile, clarification }, { record: true });
          }
          const current =
            runtime.composition.createContext<ReturnType<typeof freshGrant>>("tool-grant");
          const acquisition = runtime.composition.createApi<{
            acquire(input: Input): Operation<Guest<Result, CapabilityRequest, Y>, Y>;
          }>("tool-acquisition", {
            *acquire(input) {
              const grant = freshGrant();
              yield* grant.install();
              yield* current.set(grant);
              acquisitions++;
              yield* runtime.composition.ensure(function* () {
                disposals++;
              });
              // Provisional acquisition assembly; no public tool execution helper yet.
              return createScopedGuest((scope) =>
                investigate.body(input, {
                  scope,
                  capabilities: { readFile: investigate.capabilities.readFile.call },
                  record: grant.record,
                  *await(start, options) {
                    const outcome = yield* grant.record(function* () {
                      const value = yield* runtime.fromPromise(async (signal) => start(signal));
                      return { ok: true as const, value };
                    }, options.record);
                    return outcome.value;
                  },
                  elicit<K extends keyof typeof investigate.elicits>(
                    key: K,
                    ...args: Parameters<(typeof investigate.elicits)[K]["call"]>
                  ) {
                    return investigate.elicits[key].call(args[0]) as ReturnType<
                      (typeof investigate.elicits)[K]["call"]
                    >;
                  },
                }),
              );
            },
          });
          let waiting: { grant: ResolutionGrant; child: Child } | undefined;
          function childHost(child: Child) {
            const recovery = createRecovery<Result, CapabilityRequest, Y, unknown, string>(
              runtime.composition,
              {
                name: "tool-recovery",
                program: investigate.id,
                matches: isDeepStrictEqual,
                acquire() {
                  // Trusted ensureChild binding pins this normalized input and program.
                  return acquisition.operations.acquire(child.link.input as Input);
                },
              },
            );
            const host = createHosting(runtime.composition, {
              name: "tool-host",
              journal: child.journal,
              recovery: recovery.operations,
              attempts: child.journal.attempts,
              interactions: child.journal.interactions,
              *handle(request) {
                const grant = yield* current.expect();
                return yield* grant.handle(request);
              },
            });
            return { host, recovery };
          }
          function* runChild(child: Child): Operation<boolean, Y> {
            yield* effects.install(readFile);
            const { host, recovery } = childHost(child);
            yield* host.around({
              *child(args, next) {
                const grant = yield* current.expect();
                return yield* grant.admission.child(args, next);
              },
              *deliveryMode([request], next) {
                return request.effect === clarification.id ? "wait" : yield* next(request);
              },
            });
            yield* installGuestRetention(runtime.composition, host, recovery, child.journal);
            const result = yield* host.operations.run();
            if (result.state === "waiting") {
              waiting = { grant: result.grant, child };
            }
            return result.state === "completed";
          }
          return {
            run() {
              return start(function* () {
                if (placement === "wrapped") {
                  yield* acquisition.around({
                    *acquire([input], next) {
                      expectTypeOf(input).toEqualTypeOf<Input>();
                      placements++;
                      return yield* next(input);
                    },
                  });
                }
                const recovery = createRecovery<Result, CapabilityRequest, Y, unknown, string>(
                  runtime.composition,
                  {
                    name: "caller-recovery",
                    program: "tool-caller",
                    matches: isDeepStrictEqual,
                    *acquire() {
                      return createScopedGuest(function* () {
                        const result = yield* caller.capabilities.investigate("AUTH");
                        if (!result.ok) {
                          throw new Error("Tool failed");
                        }
                        expectTypeOf(result.value).toEqualTypeOf<Result>();
                        return result.value;
                      });
                    },
                  },
                );
                const host = createHosting(runtime.composition, {
                  name: "caller-host",
                  journal,
                  recovery: recovery.operations,
                  attempts: journal.attempts,
                  *handle() {
                    throw new Error("Durable tool must route to an owned child");
                  },
                });
                yield* host.around(caller.admission);
                yield* host.around({
                  *child([pending], next) {
                    if (pending.request.effect !== investigate.id) {
                      return yield* next(pending);
                    }
                    const snapshot = yield* journal.read();
                    const existing = snapshot.status === "running" ? snapshot.child : undefined;
                    let input: Input;
                    if (existing) {
                      input = existing.input as Input;
                    } else {
                      const parsed = yield* runtime.fromPromise(async () =>
                        investigate.context["~standard"].validate(pending.request.input),
                      );
                      if (parsed.issues) {
                        throw new Error("Invalid tool input");
                      }
                      input = parsed.value;
                    }
                    const child = yield* journal.ensureChild<
                      Result,
                      CapabilityRequest,
                      unknown,
                      string
                    >(pending.id, {
                      program: investigate.id,
                      input,
                      outcome(value) {
                        projections++;
                        return { ok: true, value: { ok: true, value } };
                      },
                    });
                    return { id: child.link.childId, run: () => runChild(child) };
                  },
                });
                return yield* host.operations.run();
              }).result;
            },
            answer(raw: unknown) {
              return start(function* () {
                if (!waiting) {
                  throw new Error("Tool is not waiting");
                }
                const { host } = childHost(waiting.child);
                const answers = yield* installEffectAnswers(
                  host,
                  effects.grant(investigate.elicits),
                  waiting.child.journal.interactions,
                );
                return yield* answers.answer(waiting.grant, { ok: true, value: raw });
              }).result;
            },
            get wait() {
              return waiting;
            },
          };
        }

        let app = assemble();
        if (recording === "promise-rejected") {
          await expect(app.run()).rejects.toThrow("Recorded Promise delivery failed");
          store.reopen();
          await expect(assemble().run()).resolves.toMatchObject({ state: "child" });
          expect({ records, reads, inputs, responses, acquisitions, disposals }).toEqual({
            records: 1,
            reads: 0,
            inputs: 1,
            responses: 0,
            acquisitions: 2,
            disposals: 2,
          });
          expect(cleanups).toBe(0);
          return;
        }
        const opening = app.run();
        await Promise.race([peer.waitForRequests(1), opening]);
        peer.reply("auth", { status: 200, body: "authentication code" });
        const parked = await opening;
        expect(parked.state).toBe("child");
        const originalWait = app.wait?.grant;
        expect(originalWait).toBeDefined();
        expect({ records, reads, inputs, acquisitions, disposals }).toEqual({
          records: 1,
          reads: 1,
          inputs: 1,
          acquisitions: 1,
          disposals: 1,
        });
        expect(cleanups).toBe(0);
        store.reopen();
        app = assemble();
        await expect(app.run()).resolves.toEqual(parked);
        expect(app.wait?.grant).toEqual(originalWait);
        await expect(app.answer(123)).rejects.toThrow("Effect schema rejected value");
        expect((await app.answer("yes")).duplicate).toBe(false);
        expect((await app.answer("yes")).duplicate).toBe(true);
        expect(acquisitions).toBe(2); // Answer ingress acquires no Guest.
        // Reopen after acceptance, before the body receives the answer or projects its result.
        store.reopen();
        app = assemble();
        const completed = {
          state: "completed",
          value: { label: "investigation-1", contents: "authentication code", approved: true },
        };
        await expect(app.run()).resolves.toEqual(completed);
        store.reopen();
        await expect(assemble().run()).resolves.toEqual(completed);
        expect({ records, reads, inputs, responses, acquisitions, disposals, projections }).toEqual(
          {
            records: 1,
            reads: 1,
            inputs: 1,
            responses: 2,
            acquisitions: 3,
            disposals: 3,
            projections: 1,
          },
        );
        expect(cleanups).toBe(1);
        expect(placements).toBe(placement === "wrapped" ? 3 : 0);
        expect(peer.requests).toEqual([{ id: "auth", token: "read" }]);
      });
    }
  }
});
