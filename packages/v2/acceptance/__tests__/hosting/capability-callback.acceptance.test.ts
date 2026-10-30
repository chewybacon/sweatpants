import {
  createHostedRecovery as createRecovery,
  createProtocolRig,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation, Work } from "@standard-durability/core";
import { type OwnedChild, type ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting, createEffectCapabilities } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";

import { forEachRuntime } from "../runtime/assembly.ts";

function textSchema<T>(transform: (value: string) => T): StandardSchemaV1<string, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "callback-acceptance",
      validate(value) {
        return typeof value === "string"
          ? { value: transform(value) }
          : { issues: [{ message: "Expected text" }] };
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

  it(`${runtime.name}: a granted parent callback parks as an owned Guest and recovers its accepted answer`, async () => {
    const peer = createProtocolRig();
    const store = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
      program: "researcher",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    let normalizations = 0;
    let answerMiddleware = 0;
    let projections = 0;

    function assemble() {
      const effects = createEffectCapabilities(runtime, "callback-effects");
      const notify = defineEffect(
        { key: "notify", context: textSchema((text) => text) },
        function* (input) {
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: input, token: "callback" }, signal),
          );
          return { ok: true, value: reply.body };
        },
      );
      const elicit = defineEffect({
        key: "elicit",
        context: textSchema((text) => text),
        response: textSchema((market) => {
          normalizations++;
          return { market: market.toUpperCase() };
        }),
      });
      const grant = effects.grant({ elicit, notify });
      const journal = store.open();
      let child:
        | OwnedChild<{ market: string }, CapabilityRequest, unknown, string, unknown, Y>
        | undefined;
      let waiting: { grant: ResolutionGrant; request: CapabilityRequest } | undefined;

      // Authored callback supplied by the parent assembly. It has its own durable work.
      function* clarify() {
        yield* grant.capabilities.notify("opened");
        const answer = yield* grant.capabilities.elicit("market");
        if (!answer.ok) {
          throw new Error("Unexpected answer failure");
        }
        expectTypeOf(answer.value).toEqualTypeOf<{ market: string }>();
        return answer.value;
      }
      function* runCallback(): Operation<boolean, Y> {
        if (!child) {
          throw new Error("Callback has not been acquired");
        }
        const recovery = createRecovery(runtime, {
          name: "callback-recovery",
          program: "clarify",
          matches: isDeepStrictEqual,
          *acquire() {
            return createScopedGuest(clarify);
          },
        });
        const host = createHosting(runtime.composition, {
          name: "callback-host",
          journal: child.journal,
          recovery: recovery.operations,
          attempts: child.journal.attempts,
          interactions: child.journal.interactions,
          handle: grant.handle,
        });
        yield* host.around(grant.admission);
        yield* host.around({
          *deliveryMode([request], next) {
            return request.effect === elicit.id ? "wait" : yield* next(request);
          },
        });
        const result = yield* host.operations.run();
        if (result.state === "waiting") {
          waiting = { grant: result.grant, request: result.pending.request };
        }
        return result.state === "completed";
      }
      function run() {
        return start(function* () {
          yield* effects.install(notify);
          const recovery = createRecovery(runtime, {
            name: "researcher-recovery",
            program: "researcher",
            matches: isDeepStrictEqual,
            *acquire() {
              return createScopedGuest(function* () {
                const answer = yield* grant.capabilities.elicit("market");
                if (!answer.ok) {
                  throw new Error("Unexpected answer failure");
                }
                return `Research ${answer.value.market}`;
              });
            },
          });
          const host = createHosting(runtime.composition, {
            name: "researcher-host",
            journal,
            recovery: recovery.operations,
            attempts: journal.attempts,
            handle: grant.handle,
          });
          yield* host.around(grant.admission);
          yield* host.around({
            *child([pending], next) {
              // Trusted assembly explicitly grants and routes this one definition.
              // This is policy glue, not a generic authorization/transport adapter.
              if (pending.request.effect !== elicit.id) {
                return yield* next(pending);
              }
              expect(pending.request.input).toBe("market");
              child = yield* journal.ensureChild<
                { market: string },
                CapabilityRequest,
                unknown,
                string
              >(pending.id, {
                program: "clarify",
                input: pending.request,
                outcome(value) {
                  projections++;
                  return { ok: true, value: { ok: true, value } };
                },
              });
              return { id: child.link.childId, run: runCallback };
            },
          });
          return yield* host.operations.run();
        });
      }
      function answer(raw: string) {
        return start(function* () {
          if (!waiting || !child) {
            throw new Error("Callback is not waiting");
          }
          // Raw participant ingress uses the same registered schema pipeline. Scoped
          // middleware supplies the peer reply; accepted replay never runs this path.
          yield* effects.api(elicit).around({
            *handle([message]) {
              expect(message).toBe("market");
              answerMiddleware++;
              return { ok: true, value: raw };
            },
          });
          const outcome = yield* grant.handle(waiting.request);
          return yield* child.journal.interactions.answer(waiting.grant, outcome);
        }).result;
      }
      return {
        run,
        answer,
        get wait() {
          return waiting;
        },
      };
    }

    const first = assemble();
    const opening = first.run();
    await Promise.race([peer.waitForRequests(1), opening.result]);
    peer.reply("opened", { status: 200, body: "acknowledged" });
    const parked = await opening.result;
    expect(parked.state).toBe("child");
    const originalWait = first.wait;
    expect(originalWait).toBeDefined();

    store.reopen();
    const second = assemble();
    await expect(second.run().result).resolves.toEqual(parked);
    expect(second.wait).toEqual(originalWait);
    expect((await second.answer("europe")).duplicate).toBe(false);
    // Stop after answer acceptance, before either Guest resumes or parent settlement.
    store.reopen();
    await expect(assemble().run().result).resolves.toEqual({
      state: "completed",
      value: "Research EUROPE",
    });
    store.reopen();
    await expect(assemble().run().result).resolves.toEqual({
      state: "completed",
      value: "Research EUROPE",
    });
    expect(peer.requests).toEqual([{ id: "opened", token: "callback" }]);
    expect({ normalizations, answerMiddleware, projections }).toEqual({
      normalizations: 1,
      answerMiddleware: 1,
      projections: 1,
    });
  });
});
