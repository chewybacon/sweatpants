import {
  createHostedRecovery as createRecovery,
  createDuplexExchangeRig,
  createSqliteJournalRig,
  readJournal,
  type DuplexExchangeRig,
} from "@sweatpan.ts/testing";
import { serialize, deserialize } from "node:v8";
import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Outcome, Work } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { type ResolutionGrant } from "@sweatpan.ts/durable";
import {
  createEffectCapabilities,
  createHosting,
  installEffectAnswers,
} from "@sweatpan.ts/hosting";

import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

type Callback = { kind: "callback"; request: CapabilityRequest; grant: ResolutionGrant };
type Command =
  | { kind: "invoke" }
  | { kind: "answer"; grant: ResolutionGrant; outcome: Outcome<unknown, unknown> };
type Step = Callback | { kind: "accepted" } | { kind: "completed"; value: string };
function schema<T>(parse: (text: string) => T): StandardSchemaV1<string, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "reverse-exchange",
      validate(value) {
        return typeof value === "string"
          ? { value: parse(value) }
          : { issues: [{ message: "Expected text" }] };
      },
    },
  };
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const mode of ["live", "handoff"] as const) {
    for (const scenario of ["complete", "lost-ack", "ungranted"] as const) {
      const permitted = scenario !== "ungranted";
      const loseAck = scenario === "lost-ack";
      it(`${runtime.name}: ${mode} reverse capability ${scenario}`, async () => {
        const store = createSqliteJournalRig<
          string,
          CapabilityRequest,
          unknown,
          string,
          unknown,
          Y
        >({ program: "researcher:reverse", equals: isDeepStrictEqual });
        onTestFinished(() => store.close());
        let normalizations = 0;
        let callbackCalls = 0;
        let acquisitions = 0;
        const elicit = defineEffect({
          key: "parent:clarify",
          context: schema((text) => text),
          response: schema((text) => {
            normalizations++;
            return { market: text.toUpperCase() };
          }),
        });
        function run<T>(work: Work<T, Y>, signal?: AbortSignal) {
          const task = runtime.start(() => (signal ? runtime.withSignal(signal, work) : work()));
          void task.result.catch(() => undefined);
          onTestFinished(() => task.cancel());
          return task.result;
        }
        // Trusted hosting service owns the journal; the Guest and remote callback never settle it directly.
        function step(command: Command, signal?: AbortSignal): Promise<Step> {
          return run(function* () {
            const journal = store.open();
            const effects = createEffectCapabilities(runtime, "researcher-grants");
            const grant = effects.grant(permitted ? { elicit } : {});
            const recovery = createRecovery(runtime, {
              name: "researcher-recovery",
              program: "researcher:reverse",
              matches: isDeepStrictEqual,
              *acquire() {
                acquisitions++;
                return createScopedGuest(function* () {
                  const result = yield* elicit.call("Which market?");
                  if (!result.ok) {
                    return "Research declined";
                  }
                  return `Research ${result.value.market}`;
                });
              },
            });
            const host = createHosting(runtime.composition, {
              name: "researcher-host",
              journal,
              recovery: recovery.operations,
              attempts: journal.attempts,
              interactions: journal.interactions,
              handle: grant.handle,
            });
            yield* host.around(grant.admission);
            yield* host.around({
              *deliveryMode() {
                return "wait";
              },
            });
            const answers = yield* installEffectAnswers(host, grant, journal.interactions);
            if (command.kind === "answer") {
              yield* answers.answer(command.grant, command.outcome);
              return { kind: "accepted" as const };
            }
            const result = yield* host.operations.run();
            if (result.state === "waiting") {
              return {
                kind: "callback" as const,
                request: result.pending.request,
                grant: result.grant,
              };
            }
            if (result.state === "completed") {
              return { kind: "completed" as const, value: result.value };
            }
            throw new Error(`Unexpected hosted state: ${result.state}`);
          }, signal);
        }
        function answer(
          callback: Callback,
          signal?: AbortSignal,
        ): Promise<Outcome<unknown, unknown>> {
          return run(function* () {
            expect(callback.request.effect).toBe(elicit.id);
            const parsed = yield* runtime.fromPromise(async () =>
              elicit.context["~standard"].validate(callback.request.input),
            );
            if (parsed.issues) {
              throw new Error("Invalid callback input");
            }
            const effects = createEffectCapabilities(runtime, "parent-handler");
            yield* effects.install(elicit, function* (question) {
              callbackCalls++;
              expect(question).toBe("Which market?");
              // Only raw authored response travels back. The authority normalizes before acceptance.
              return { ok: true, value: "north" };
            });
            return yield* effects.api(elicit).operations.handle(parsed.value);
          }, signal);
        }
        let observeLoss!: () => void;
        const lost = new Promise<void>((resolve) => {
          observeLoss = resolve;
        });
        let firstConnection = true;
        let live: DuplexExchangeRig<Callback, Outcome<unknown, unknown>, Command, Step> | undefined;
        function connect() {
          if (mode === "handoff") {
            return async (command: Command): Promise<Step> => {
              // Each request has its own scope and detached bytes; no live peer survives the reply.
              const result = await step(deserialize(serialize(command)) as Command);
              const bytes = serialize(result);
              if (firstConnection && loseAck && command.kind === "answer") {
                observeLoss();
                throw new Error("Connection lost before acceptance acknowledgement");
              }
              return deserialize(bytes) as Step;
            };
          }
          const connection = createDuplexExchangeRig<
            Callback,
            Outcome<unknown, unknown>,
            Command,
            Step,
            Y
          >(runtime, {
            async left(callback, signal) {
              // Parent invocation is still outstanding while its reverse handler executes.
              expect(connection.left.pending).toBe(1);
              expect(connection.right.pending).toBe(1);
              return answer(callback, signal);
            },
            async right(command, signal) {
              let result = await step(command, signal);
              while (result.kind === "callback") {
                const outcome = await connection.right.exchange(result);
                await step({ kind: "answer", grant: result.grant, outcome }, signal);
                if (firstConnection && loseAck) {
                  // Fault window: authority committed, but caller has received no completion/receipt.
                  observeLoss();
                  await new Promise<void>((_resolve, reject) => {
                    const abort = () => reject(signal.reason);
                    signal.addEventListener("abort", abort, { once: true });
                    if (signal.aborted) {
                      abort();
                    }
                  });
                }
                result = await step({ kind: "invoke" }, signal);
              }
              return result;
            },
          });
          live = connection;
          onTestFinished(() => connection.close());
          return (command: Command) => connection.left.exchange(command);
        }
        const transport = connect();
        const invoke = async () => {
          let result = await transport({ kind: "invoke" });
          if (mode === "handoff" && result.kind === "callback") {
            const outcome = await answer(result);
            await transport({ kind: "answer", grant: result.grant, outcome });
            result = await transport({ kind: "invoke" });
          }
          return result;
        };
        const first = invoke();
        void first.catch(() => undefined);
        if (!permitted) {
          await expect(first).rejects.toThrow("Effect is not granted");
          expect(callbackCalls).toBe(0);
          expect(normalizations).toBe(0);
          const saved = await run(() => readJournal(store.open()));
          expect(saved.history).toEqual([]);
          return;
        }
        if (!loseAck) {
          expect(await first).toEqual({ kind: "completed", value: "Research NORTH" });
          expect(callbackCalls).toBe(1);
          expect(normalizations).toBe(1);
          expect((await run(() => readJournal(store.open()))).history).toHaveLength(1);
          return;
        }
        await Promise.race([lost, first]);
        if (live) {
          expect(live.requests.map((request) => request.from)).toEqual(["left", "right"]);
          await live.close();
        }
        await expect(first).rejects.toThrow("Connection lost");
        const saved = await run(() => readJournal(store.open()));
        expect(saved.history).toHaveLength(1);
        expect(saved.history[0]!.outcome).toEqual({
          ok: true,
          value: { ok: true, value: { market: "NORTH" } },
        });
        const beforeRecovery = acquisitions;
        store.reopen();
        firstConnection = false;
        const resumed = connect();
        expect(await resumed({ kind: "invoke" })).toEqual({
          kind: "completed",
          value: "Research NORTH",
        });
        expect(acquisitions).toBeGreaterThan(beforeRecovery);
        expect(callbackCalls).toBe(1);
        expect(normalizations).toBe(1);
        expect((await run(() => readJournal(store.open()))).history).toHaveLength(1);
      });
    }
  }
});
