import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import {
  composeOperation,
  type Operation,
  type OperationMiddleware,
  type Work,
} from "@standard-durability/core";
import { createScopedGuest, type Guest, type GuestWork, type Turn } from "@sweatpan.ts/execution";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createProtocolRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

function* read(id: string): Operation<string, { id: string }> {
  const reply: unknown = yield { id };
  if (typeof reply !== "string") {
    throw new Error("Expected text reply");
  }
  return reply;
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  describe(`${runtime.name}: acquisition and Guest method composition`, () => {
    for (const finish of ["complete", "park"] as const) {
      it(`${finish} composes two independent Guests with scoped policy and inferred results`, async () => {
        const peer = createProtocolRig();
        const token = runtime.composition.createContext<string>("guest-policy");
        const trace: string[] = [];
        let started = 0;
        let authoredCleanup = 0;
        let acquired = 0;

        // Host assembly fixes Y; authored result/request types remain inferred.
        function prepare<R, Q>(work: Work<R, Q>): GuestWork<R, Q, Y> {
          const acquire: GuestWork<R, Q, Y> = function* () {
            const id = ++acquired;
            const raw = createScopedGuest(work);
            const guest: Guest<R, Q, Y> = raw;
            // Physical ownership stays with this scope, even if a wrapper replaces close.
            yield* runtime.composition.ensure(function* () {
              yield* raw.close();
              yield* runtime.fromPromise((signal) =>
                peer.send({ id: `release:${id}`, token: "physical" }, signal),
              );
            });
            const layers: OperationMiddleware<typeof guest> = {
              *start(args, next) {
                trace.push(`start:${id}`);
                return yield* next(...args);
              },
              *resume(args, next) {
                const credential = yield* token.expect();
                yield* runtime.fromPromise((signal) =>
                  peer.send({ id: `resume:${id}`, token: credential }, signal),
                );
                const turn = yield* next(...args);
                expectTypeOf(turn).toEqualTypeOf<Turn<R, Q>>();
                return turn;
              },
              *close(args, next) {
                trace.push(`close:${id}`);
                return yield* next(...args);
              },
            };
            // The same layer object is accepted by scoped API installation.
            const scoped = runtime.composition.createApi<Guest<R, Q, Y>>(`guest:${id}`, guest);
            yield* scoped.around(layers);
            // Direct decoration binds this particular handle; no global Guest driver.
            return {
              start: composeOperation(() => guest.start(), [layers.start]),
              resume: composeOperation((outcome) => guest.resume(outcome), [layers.resume]),
              close: composeOperation(() => scoped.operations.close(), []),
            };
          };
          return composeOperation(acquire, [
            function* (args, next) {
              trace.push("acquire:in");
              const guest = yield* next(...args);
              trace.push("acquire:out");
              return guest;
            },
          ]);
        }

        const acquire = prepare(function* () {
          started++;
          try {
            const text = yield* read("document");
            return { text, length: text.length };
          } finally {
            authoredCleanup++;
          }
        });
        expect(trace).toEqual([]);
        const execution = runtime.start(function* () {
          yield* token.set("parent");
          const first = yield* acquire();
          const second = yield* acquire();
          expect(started).toBe(0);
          const one = yield* first.start();
          const two = yield* second.start();
          expectTypeOf(one).toEqualTypeOf<Turn<{ text: string; length: number }, { id: string }>>();
          expect(one).toEqual({
            kind: "suspended",
            request: { id: "document" },
            scope: { scopeId: "root", frameId: "root/body:-1", phase: "body", critical: undefined },
          });
          expect(two).toEqual(one);
          if (finish === "park") {
            yield* first.close();
            yield* second.close();
            return { one, two };
          }
          const completedOne = yield* runtime.composition.scoped(function* () {
            yield* token.set("child");
            return yield* first.resume({ ok: true, value: "alpha" });
          });
          const completedTwo = yield* second.resume({ ok: true, value: "beta" });
          yield* first.close();
          yield* second.close();
          return { one: completedOne, two: completedTwo };
        });
        void execution.result.catch(() => undefined);
        onTestFinished(() => execution.cancel());
        const expected =
          finish === "complete"
            ? [
                { id: "resume:1", token: "child" },
                { id: "resume:2", token: "parent" },
                { id: "release:2", token: "physical" },
                { id: "release:1", token: "physical" },
              ]
            : [
                { id: "release:2", token: "physical" },
                { id: "release:1", token: "physical" },
              ];
        // Always acknowledge physical release before reporting assertions.
        for (const [index, request] of expected.entries()) {
          await peer.waitForRequests(index + 1);
          peer.reply(request.id, { status: 200, body: "accepted" });
        }
        const result = await execution.result;
        expect(peer.requests).toEqual(expected);
        expect(started).toBe(2);
        expect(authoredCleanup).toBe(finish === "complete" ? 2 : 0);
        expect(trace).toEqual([
          "acquire:in",
          "acquire:out",
          "acquire:in",
          "acquire:out",
          "start:1",
          "start:2",
          "close:1",
          "close:2",
        ]);
        if (finish === "complete") {
          expect(result).toEqual({
            one: { kind: "completed", value: { text: "alpha", length: 5 } },
            two: { kind: "completed", value: { text: "beta", length: 4 } },
          });
        }
      });
    }

    it("infers API results directly from an operation implementation", async () => {
      const peer = createProtocolRig();
      const api = runtime.composition.createApi("inferred-read", {
        *read(id: string) {
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id, token: "read" }, signal),
          );
          return { text: reply.body, length: reply.body.length };
        },
      });
      const execution = runtime.start(function* () {
        yield* api.around({
          *read([id], next) {
            const result = yield* next(id);
            expectTypeOf(result).toEqualTypeOf<{ text: string; length: number }>();
            return { ...result, text: result.text.toUpperCase() };
          },
        });
        return yield* api.operations.read("document");
      });
      void execution.result.catch(() => undefined);
      onTestFinished(() => execution.cancel());
      await peer.waitForRequests(1);
      peer.reply("document", { status: 200, body: "hello" });
      expect(await execution.result).toEqual({ text: "HELLO", length: 5 });
    });
  });
});
