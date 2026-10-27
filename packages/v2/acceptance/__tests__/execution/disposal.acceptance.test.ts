import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import { createIteratorGuest } from "@sweatpan.ts/execution";
import type { Operation, Turn } from "@sweatpan.ts/execution";
import { createLatch, createProtocolRig } from "@sweatpan.ts/testing";
import type { RuntimeExecution } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

type Request =
  | { kind: "reserve" }
  | { kind: "approval"; reservation: string }
  | { kind: "release"; reservation: string };

function* reserve(): Operation<string, Request> {
  const reply: unknown = yield { kind: "reserve" };
  if (typeof reply !== "string") {
    throw new Error("Expected reservation identity");
  }
  return reply;
}

function* approve(reservation: string): Operation<boolean, Request> {
  const reply: unknown = yield { kind: "approval", reservation };
  if (typeof reply !== "boolean") {
    throw new Error("Expected approval answer");
  }
  return reply;
}

function own<T>(execution: RuntimeExecution<T>) {
  void execution.result.catch(() => undefined);
  onTestFinished(() => execution.cancel());
  return execution;
}

forEachRuntime((runtime) => {
  describe(`${runtime.name}: disposing a suspended authored continuation`, () => {
    for (const stop of ["park", "native-cancel"] as const) {
      it(`${stop} closes the physical session without running authored finally`, async () => {
        const peer = createProtocolRig();
        const acquired = createLatch<void>();
        const advance = createLatch<void>();
        const suspended = createLatch<void>();
        let factories = 0;
        let authoredCleanup = 0;
        let pending: Turn<{ approved: boolean }, Request> | undefined;
        const guest = createIteratorGuest(() => {
          factories++;
          return (function* () {
            const reservation = yield* reserve();
            try {
              const approved = yield* approve(reservation);
              return { approved };
            } finally {
              authoredCleanup++;
              yield { kind: "release", reservation } satisfies Request;
            }
          })();
        });
        function* exchange(id: string) {
          return yield* runtime.fromPromise((signal) =>
            peer.send({ id, token: "physical-session" }, signal),
          );
        }
        let finished = false;
        const execution = own(
          runtime.start(function* () {
            return yield* runtime.using(
              function* () {
                yield* exchange("open");
                acquired.resolve();
                return guest;
              },
              function* (cursor) {
                yield* runtime.fromPromise(() => advance.promise);
                const request = yield* cursor.start();
                if (request.kind !== "suspended" || request.request.kind !== "reserve") {
                  throw new Error("Expected reservation request");
                }
                const reply = yield* exchange("reserve");
                pending = yield* cursor.resume({ ok: true, value: reply.body });
                suspended.resolve();
                if (stop === "native-cancel") {
                  yield* exchange("host-wait");
                }
                return pending;
              },
              function* (cursor) {
                yield* cursor.close();
                yield* cursor.close();
                yield* exchange("close");
              },
            );
          }),
        );
        void execution.result.then(
          () => {
            finished = true;
          },
          () => {
            finished = true;
          },
        );
        await peer.waitForRequests(1);
        expect(factories).toBe(0);
        peer.reply("open", { status: 200, body: "opened" });
        await acquired.promise;
        expect(factories).toBe(0);
        expect(authoredCleanup).toBe(0);
        advance.resolve();
        await peer.waitForRequests(2);
        expect(factories).toBe(1);
        peer.reply("reserve", { status: 200, body: "reservation-1" });
        await suspended.promise;
        expect(pending).toEqual({
          kind: "suspended",
          request: { kind: "approval", reservation: "reservation-1" },
        });
        let cancellation: Promise<void> | undefined;
        if (stop === "native-cancel") {
          await peer.waitForRequests(3);
          cancellation = execution.cancel();
        }
        await peer.waitForRequests(stop === "park" ? 3 : 4);
        expect(peer.requests.at(-1)?.id).toBe("close");
        expect(finished).toBe(false);
        expect(authoredCleanup).toBe(0);
        peer.reply("close", { status: 200, body: "closed" });
        if (cancellation) {
          await cancellation;
          await expect(execution.result).rejects.toBeDefined();
          expect(peer.aborted).toEqual(["host-wait"]);
        } else {
          expect(await execution.result).toEqual(pending);
        }
        expect(authoredCleanup).toBe(0);
        expect(peer.requests.filter(({ id }) => id === "release")).toHaveLength(0);
        await expect(
          runtime.start(() => guest.resume({ ok: true, value: true })).result,
        ).rejects.toThrow("closed");
        await expect(runtime.start(() => guest.start()).result).rejects.toThrow("closed");
      });
    }

    it("can dispose before first advancement without constructing the authored iterator", async () => {
      const peer = createProtocolRig();
      let created = 0;
      const guest = createIteratorGuest(() => {
        created++;
        return (function* () {
          return yield* reserve();
        })();
      });
      const execution = own(
        runtime.start(function* () {
          yield* guest.close();
          yield* guest.close();
          return yield* runtime.fromPromise((signal) =>
            peer.send({ id: "close-unstarted", token: "session" }, signal),
          );
        }),
      );
      await peer.waitForRequests(1);
      expect(created).toBe(0);
      peer.reply("close-unstarted", { status: 200, body: "closed" });
      await execution.result;
      await expect(runtime.start(() => guest.start()).result).rejects.toThrow("closed");
      expect(created).toBe(0);
    });

    it("advances authored finally only through explicit resume and preserves its inferred result", async () => {
      const peer = createProtocolRig();
      const guest = createIteratorGuest(function* () {
        const reservation = yield* reserve();
        try {
          const approved = yield* approve(reservation);
          return { approved };
        } finally {
          yield { kind: "release", reservation } satisfies Request;
        }
      });
      const execution = own(
        runtime.start(function* () {
          return yield* runtime.using(
            function* () {
              return guest;
            },
            function* (cursor) {
              let turn = yield* cursor.start();
              while (turn.kind === "suspended") {
                const request = turn.request;
                const reply = yield* runtime.fromPromise((signal) =>
                  peer.send({ id: request.kind, token: "session" }, signal),
                );
                const value = request.kind === "approval" ? reply.body === "yes" : reply.body;
                turn = yield* cursor.resume({ ok: true, value });
              }
              return turn.value;
            },
            (cursor) => cursor.close(),
          );
        }),
      );
      await peer.waitForRequests(1);
      peer.reply("reserve", { status: 200, body: "reservation-1" });
      await peer.waitForRequests(2);
      peer.reply("approval", { status: 200, body: "yes" });
      await peer.waitForRequests(3);
      expect(peer.requests.map(({ id }) => id)).toEqual(["reserve", "approval", "release"]);
      peer.reply("release", { status: 200, body: "released" });
      const result = await execution.result;
      expectTypeOf(result).toEqualTypeOf<{ approved: boolean }>();
      expect(result).toEqual({ approved: true });
    });
  });
});
