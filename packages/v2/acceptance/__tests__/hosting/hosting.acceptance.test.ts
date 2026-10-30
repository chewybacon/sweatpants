import { readJournal } from "@sweatpan.ts/testing";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Work, Operation, Outcome } from "@standard-durability/core";
import {
  createRecovery,
  type AttemptGrant,
  type Attempts,
  type RetrySafety,
} from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createHosting,
  installGuestRetention,
  installAttemptCancellation,
  type HostedResult,
} from "@sweatpan.ts/hosting";
import {
  createProtocolRig,
  createNotificationRig,
  createLatch,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import type { Serializer } from "@sweatpan.ts/storage";
import { v8Serializer } from "@sweatpan.ts/storage-sqlite";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const lifetime of ["recover", "retain"] as const) {
    function start<T>(work: Work<T, Y>) {
      const execution = runtime.start(work);
      void execution.result.catch(() => undefined);
      onTestFinished(() => execution.cancel());
      return execution;
    }
    function scenario(
      liveCancellation = false,
      serialization?: { resolve(): Operation<Serializer, Y> },
    ) {
      const store = createSqliteJournalRig<
        { reservation: string },
        string,
        string,
        string,
        unknown,
        Y
      >({
        program: "reservation",
        equals: isDeepStrictEqual,
        serialization,
      });
      onTestFinished(() => store.close());
      let journal = store.open();
      const peer = createProtocolRig();
      const grants: AttemptGrant[] = [];
      const notifications = createNotificationRig();
      let beforeSubscribe: Work<void, Y> | undefined;
      let beforePublish: Work<void, Y> | undefined;
      let release: Work<void, Y> | undefined;
      let afterInspect: Work<void, Y> | undefined;
      let reads = 0;
      const control = {
        *inspect(grant: AttemptGrant) {
          reads++;
          const state = yield* journal.attemptControl.inspect(grant);
          if (afterInspect) {
            yield* afterInspect();
          }
          return state;
        },
        *invalidate(grant: AttemptGrant, reason: string) {
          return yield* journal.attemptControl.invalidate(grant, reason);
        },
      };
      const transportNotifications = {
        *subscribe(grant: AttemptGrant) {
          if (beforeSubscribe) {
            yield* beforeSubscribe();
          }
          const subscription = notifications.subscribe(grant.attemptId);
          yield* runtime.composition.ensure(function* () {
            subscription.close();
          });
          return subscription.signal;
        },
        *publish(grant: AttemptGrant) {
          if (beforePublish) {
            yield* beforePublish();
          }
          notifications.publish(grant.attemptId);
        },
      };
      function* install(
        hosting: ReturnType<typeof host>["hosting"],
        recovery: ReturnType<typeof host>["recovery"],
      ) {
        if (lifetime === "retain") {
          yield* installGuestRetention(runtime.composition, hosting, recovery, journal);
        }
        if (liveCancellation) {
          yield* installAttemptCancellation(runtime, hosting, control, transportNotifications);
        }
      }

      let physicalDisposals = 0;
      function host(attempts: Attempts<string, string, string, Y> = journal.attempts) {
        const recovery = createRecovery(runtime.composition, {
          name: "reservation-recovery",
          program: "reservation",
          matches: isDeepStrictEqual,
          *acquire() {
            const guest = createScopedGuest(function* () {
              const reservation: unknown = yield "reserve";
              if (typeof reservation !== "string") {
                throw new Error("Expected reservation");
              }
              return { reservation };
            });
            return {
              ...guest,
              *close() {
                yield* guest.close();
                physicalDisposals++;
              },
            };
          },
        });
        const hosting = createHosting(runtime.composition, {
          name: "reservation-host",
          recovery: recovery.operations,
          journal,
          attempts,
          attemptControl: control,
          *handle(request: string): Operation<Outcome<string, string>, Y> {
            const grant: AttemptGrant = yield* hosting.delivery.expect();
            grants.push(grant);
            if (release) {
              yield* runtime.composition.ensure(release);
            }
            // Computation is physically disposed before effect execution begins.
            if (lifetime === "recover") {
              expect(physicalDisposals).toBeGreaterThanOrEqual(grants.length);
            }
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send({ id: grant.attemptId, token: grant.requestId }, signal),
            );
            expect(request).toBe("reserve");
            return { ok: true, value: reply.body } as const;
          },
        });
        return { hosting, recovery };
      }
      function run(
        safety: RetrySafety = "unsafe",
        replace?: AttemptGrant,
        attempts?: Attempts<string, string, string, Y>,
        gates: { beforePark?: Work<void, Y>; beforeBegin?: Work<void, Y> } = {},
      ) {
        const { hosting, recovery } = host(attempts);
        return start(function* () {
          yield* install(hosting, recovery);
          if (gates.beforePark) {
            const gate = gates.beforePark;
            yield* recovery.around({
              *recover(args, next) {
                const recovered = yield* next(...args);
                yield* gate();
                return recovered;
              },
            });
          }
          yield* hosting.around({
            *retrySafety() {
              if (gates.beforeBegin) {
                yield* gates.beforeBegin();
              }
              return safety;
            },
          });
          return yield* hosting.operations.run(replace);
        });
      }
      async function wait(count: number, result: Promise<unknown>) {
        await Promise.race([
          peer.waitForRequests(count),
          result.then(() => {
            throw new Error("Host ended before request");
          }),
        ]);
      }
      function invalidate(grant: AttemptGrant, reason = "deadline") {
        const { hosting, recovery } = host();
        return start(function* () {
          yield* install(hosting, recovery);
          return yield* hosting.operations.invalidateAttempt(grant, reason);
        }).result;
      }
      return {
        get journal() {
          return journal;
        },
        reopen() {
          journal = store.open();
        },
        reconnect() {
          journal = store.reopen();
        },
        compete: () => store.connect(),
        peer,
        grants,
        run,
        wait,
        invalidate,
        notifications,
        afterInspect(work: Work<void, Y>) {
          afterInspect = work;
        },
        get reads() {
          return reads;
        },
        beforePublish(work: Work<void, Y>) {
          beforePublish = work;
        },
        beforeSubscribe(work: Work<void, Y>) {
          beforeSubscribe = work;
        },
        release(work: Work<void, Y>) {
          release = work;
        },
      };
    }
    describe(`${runtime.name} ${lifetime}: SQLite hosted attempt sandwich`, () => {
      for (const failure of ["none", "encode", "cancel-during-resolution"] as const) {
        it(`composes scoped serialization at hosted delivery (${failure})`, async () => {
          const resolving = createLatch<void>();
          const continueResolution = createLatch<void>();
          const selected = runtime.composition.createContext<Serializer>("delivery-serializer");
          const serialization = runtime.composition.createApi("delivery-serialization", {
            *resolve(): Operation<Serializer, Y> {
              return (yield* selected.get()) ?? v8Serializer;
            },
          });
          const s = scenario(false, serialization.operations);
          let encoded = 0;
          let decoded = 0;
          let restoredParent = false;
          const childSerializer: Serializer = {
            ...v8Serializer,
            encode(value) {
              if (failure === "encode") {
                throw new Error("Encoding rejected");
              }
              return v8Serializer.encode(value);
            },
          };
          const transport: Attempts<string, string, string, Y> = {
            begin: s.journal.attempts.begin,
            *settle(grant, outcome) {
              try {
                return yield* runtime.composition.scoped(function* () {
                  yield* selected.set(childSerializer);
                  const payload = {
                    ...outcome,
                    metadata: new Map([["sequence", 1n]]),
                    bytes: new Uint8Array([1, 2]),
                  };
                  return yield* s.journal.attempts.settle(grant, payload);
                });
              } finally {
                // Plain context lookup in finally; no asynchronous logical cleanup is required.
                const parent = yield* selected.expect();
                restoredParent = parent === v8Serializer;
              }
            },
          };
          const execution = s.run("unsafe", undefined, transport, {
            *beforeBegin() {
              yield* selected.set(v8Serializer);
              yield* serialization.around({
                *resolve(args, next) {
                  const serializer = yield* next(...args);
                  if (serializer !== childSerializer) {
                    return serializer;
                  }
                  if (failure === "cancel-during-resolution") {
                    resolving.resolve();
                    yield* runtime.fromPromise(() => continueResolution.promise);
                  }
                  return {
                    ...serializer,
                    encode(value) {
                      encoded++;
                      return serializer.encode(value);
                    },
                    decode(bytes) {
                      decoded++;
                      return serializer.decode(bytes);
                    },
                  };
                },
              });
            },
          });
          await s.wait(1, execution.result);
          const grant = s.grants[0]!;
          s.peer.reply(grant.attemptId, { status: 200, body: "reservation-1" });
          if (failure === "cancel-during-resolution") {
            await Promise.race([resolving.promise, execution.result]);
            const competitor = s.compete();
            await start(() => competitor.attemptControl.invalidate(grant, "deadline")).result;
            continueResolution.resolve();
          }
          if (failure === "none") {
            expect(await execution.result).toEqual({
              state: "completed",
              value: { reservation: "reservation-1" },
            });
            s.reconnect();
            expect(await s.run().result).toEqual({
              state: "completed",
              value: { reservation: "reservation-1" },
            });
          } else {
            await expect(execution.result).rejects.toThrow(
              failure === "encode" ? "Encoding rejected" : "revoked",
            );
            expect((await start(() => readJournal(s.journal)).result).history).toEqual([]);
            expect((await s.run().result).state).toBe(
              failure === "encode" ? "occupied" : "invalidated",
            );
          }
          expect(restoredParent).toBe(true);
          // Only the settlement child scope is instrumented: head + exact request reads,
          // one head write and one new accepted row; revocation writes nothing.
          expect(encoded).toBe(failure === "none" ? 2 : failure === "encode" ? 1 : 0);
          expect(decoded).toBe(2);
          if (failure === "none") {
            const saved = await start(() => readJournal(s.journal)).result;
            expect(saved.history[0]!.outcome).toEqual({
              ok: true,
              value: "reservation-1",
              metadata: new Map([["sequence", 1n]]),
              bytes: new Uint8Array([1, 2]),
            });
          }
          expect(s.peer.requests).toHaveLength(1);
        });
      }

      it("rejects an unsupported stored format without delivering another effect", async () => {
        let incompatible = false;
        const s = scenario(false, {
          *resolve() {
            return incompatible ? { ...v8Serializer, format: "unsupported" } : v8Serializer;
          },
        });
        const first = s.run();
        await s.wait(1, first.result);
        incompatible = true;
        await expect(s.run().result).rejects.toThrow("Unsupported stored serialization format");
        incompatible = false;
        s.peer.reply(s.grants[0]!.attemptId, { status: 200, body: "reservation-1" });
        expect(await first.result).toEqual({
          state: "completed",
          value: { reservation: "reservation-1" },
        });
        expect(s.peer.requests).toHaveLength(1);
      });

      it("denies competing delivery, replaces explicitly and rejects stale control and late results", async () => {
        const s = scenario(true);
        const first = s.run("repeatable");
        await s.wait(1, first.result);
        const original = s.grants[0]!;
        expect(await s.run("repeatable").result).toEqual({ state: "occupied", grant: original });
        expect(s.peer.requests).toHaveLength(1);
        const second = s.run("repeatable", original);
        await s.wait(2, second.result);
        s.reopen();
        const replacement = s.grants[1]!;
        expect(replacement.requestId).toBe(original.requestId);
        expect(replacement.attemptId).not.toBe(original.attemptId);
        await expect(s.invalidate(original)).rejects.toThrow("Stale attempt grant");
        await expect(s.invalidate({ ...replacement, attemptId: "foreign" })).rejects.toThrow(
          "Stale attempt grant",
        );
        expect(s.peer.aborted).toEqual([]);
        await expect(s.run("repeatable", original).result).rejects.toThrow("replacement conflict");
        s.peer.reply(original.attemptId, { status: 200, body: "stale-reservation" });
        await expect(first.result).rejects.toThrow("Stale attempt grant");
        expect((await start(() => readJournal(s.journal)).result).history).toEqual([]);
        s.peer.reply(replacement.attemptId, { status: 200, body: "reservation-1" });
        const completed = await second.result;
        expectTypeOf(completed).toEqualTypeOf<HostedResult<{ reservation: string }, string>>();
        expect(completed).toEqual({ state: "completed", value: { reservation: "reservation-1" } });
        expect((await start(() => readJournal(s.journal)).result).history).toHaveLength(1);
        expect(await s.run().result).toEqual(completed);
        s.reconnect();
        await expect(
          start(() => s.journal.attempts.settle(original, { ok: true, value: "stale" })).result,
        ).rejects.toThrow("Stale attempt grant");
        expect(
          (
            await start(() =>
              s.journal.attempts.settle(replacement, { ok: true, value: "reservation-1" }),
            ).result
          ).duplicate,
        ).toBe(true);
        expect(s.peer.requests).toHaveLength(2);
      });

      for (const live of [false, true]) {
        it(`fences late outcomes when cancellation notification is unavailable (middleware: ${live})`, async () => {
          const s = scenario(live);
          s.notifications.drop = true;
          const first = s.run("repeatable");
          await s.wait(1, first.result);
          const grant = s.grants[0]!;
          expect(await s.invalidate(grant)).toEqual({ state: "invalidated", reason: "deadline" });
          expect(await s.invalidate(grant, "different reason")).toEqual({
            state: "invalidated",
            reason: "deadline",
          });
          s.reopen();
          expect(s.peer.aborted).toEqual([]);
          s.peer.reply(grant.attemptId, { status: 200, body: "too late" });
          await expect(first.result).rejects.toThrow("Attempt authority revoked");
          expect(s.reads).toBe(live ? 1 : 0);
          expect((await start(() => readJournal(s.journal)).result).history).toEqual([]);
          expect(await s.run().result).toEqual({ state: "invalidated", grant, reason: "deadline" });
          await expect(s.run("repeatable", grant).result).rejects.toThrow("Invalidated attempt");
          expect(s.peer.requests).toHaveLength(1);
          expect(s.notifications.subscriptions).toBe(0);
        });
      }

      it("retains invalidation after publication failure and retries notification on repeated commands", async () => {
        const s = scenario(true);
        let publications = 0;
        s.beforePublish(function* () {
          publications++;
          if (publications === 1) {
            throw new Error("Notification transport unavailable");
          }
        });
        const first = s.run();
        await s.wait(1, first.result);
        const grant = s.grants[0]!;
        await expect(s.invalidate(grant)).rejects.toThrow("Notification transport unavailable");
        expect(s.peer.aborted).toEqual([]);
        expect(await s.run().result).toEqual({ state: "invalidated", grant, reason: "deadline" });
        expect(await s.invalidate(grant, "retry")).toEqual({
          state: "invalidated",
          reason: "deadline",
        });
        await expect(first.result).rejects.toBeDefined();
        expect(publications).toBe(2);
        expect(s.peer.aborted).toEqual([grant.attemptId]);
        expect(s.notifications.subscriptions).toBe(0);
        expect((await start(() => readJournal(s.journal)).result).history).toEqual([]);
      });

      it("interrupts live IO and joins asynchronous cleanup after committed invalidation", async () => {
        const s = scenario(true);
        const cleanup = createProtocolRig();
        s.release(function* () {
          yield* runtime.fromPromise((signal) =>
            cleanup.send({ id: "close", token: "release" }, signal),
          );
        });
        const first = s.run();
        await s.wait(1, first.result);
        const grant = s.grants[0]!;
        expect(await s.invalidate(grant)).toEqual({ state: "invalidated", reason: "deadline" });
        await Promise.race([cleanup.waitForRequests(1), first.result]);
        expect(s.peer.aborted).toEqual([grant.attemptId]);
        let finished = false;
        void first.result.then(
          () => {
            finished = true;
          },
          () => {
            finished = true;
          },
        );
        await Promise.resolve();
        expect(finished).toBe(false);
        // Duplicate notification cannot interrupt an already-running release.
        await s.invalidate(grant);
        expect(cleanup.aborted).toEqual([]);
        cleanup.reply("close", { status: 200, body: "released" });
        await expect(first.result).rejects.toBeDefined();
        expect(s.notifications.subscriptions).toBe(0);
        expect((await start(() => readJournal(s.journal)).result).history).toEqual([]);
        expect(await s.run().result).toEqual({ state: "invalidated", grant, reason: "deadline" });
      });

      it("detects invalidation committed before notification subscription without starting the handler", async () => {
        const s = scenario(true);
        const gate = createProtocolRig();
        s.beforeSubscribe(function* () {
          yield* runtime.fromPromise((signal) =>
            gate.send({ id: "subscribe", token: "ready" }, signal),
          );
        });
        const first = s.run();
        await Promise.race([gate.waitForRequests(1), first.result]);
        const occupied = await s.run().result;
        if (occupied.state !== "occupied") {
          throw new Error("Expected occupied attempt");
        }
        await s.invalidate(occupied.grant);
        gate.reply("subscribe", { status: 200, body: "continue" });
        await expect(first.result).rejects.toThrow("no longer active");
        expect(s.peer.requests).toEqual([]);
        expect(s.notifications.subscriptions).toBe(0);
      });

      it("does not enter the handler when notification arrives after the eligibility read", async () => {
        const s = scenario(true);
        const gate = createProtocolRig();
        s.afterInspect(function* () {
          yield* runtime.fromPromise((signal) =>
            gate.send({ id: "inspect", token: "ready" }, signal),
          );
        });
        const first = s.run();
        await Promise.race([gate.waitForRequests(1), first.result]);
        const occupied = await s.run().result;
        if (occupied.state !== "occupied") {
          throw new Error("Expected occupied attempt");
        }
        await s.invalidate(occupied.grant);
        gate.reply("inspect", { status: 200, body: "continue" });
        await expect(first.result).rejects.toBeDefined();
        expect(s.peer.requests).toEqual([]);
        expect(s.notifications.subscriptions).toBe(0);
        expect((await start(() => readJournal(s.journal)).result).history).toEqual([]);
      });

      it("preserves an outcome accepted before invalidation and never publishes a cancellation", async () => {
        const s = scenario(true);
        const first = s.run();
        await s.wait(1, first.result);
        const grant = s.grants[0]!;
        s.peer.reply(grant.attemptId, { status: 200, body: "reservation-1" });
        await first.result;
        const probe = s.notifications.subscribe(grant.attemptId);
        try {
          expect((await s.invalidate(grant)).state).toBe("accepted");
          expect(probe.signal.aborted).toBe(false);
          expect(await s.run().result).toEqual({
            state: "completed",
            value: { reservation: "reservation-1" },
          });
        } finally {
          probe.close();
        }
        expect(s.notifications.subscriptions).toBe(0);
      });

      for (const originalSafety of ["unsafe", "repeatable"] as const) {
        it(`does not retry when recorded or current policy is unsafe (recorded: ${originalSafety})`, async () => {
          const s = scenario();
          const first = s.run(originalSafety);
          await s.wait(1, first.result);
          s.peer.fail(
            s.grants[0]!.attemptId,
            new Error("Connection lost after service may have acted"),
          );
          await expect(first.result).rejects.toThrow("Connection lost");
          const currentSafety = originalSafety === "unsafe" ? "repeatable" : "unsafe";
          const occupied = await s.run(currentSafety).result;
          expect(occupied.state).toBe("occupied");
          await expect(s.run(currentSafety, s.grants[0]).result).rejects.toThrow("Unsafe attempt");
          expect(s.peer.requests).toHaveLength(1);
          expect((await start(() => readJournal(s.journal)).result).history).toEqual([]);
        });
      }

      for (const safety of ["unsafe", "repeatable"] as const) {
        it(`host shutdown aborts delivery but leaves the workflow recoverable (${safety})`, async () => {
          const s = scenario();
          const first = s.run(safety);
          await s.wait(1, first.result);
          const grant = s.grants[0]!;
          await first.cancel();
          await expect(first.result).rejects.toBeDefined();
          expect(s.peer.aborted).toEqual([grant.attemptId]);
          const snapshot = await start(() => readJournal(s.journal)).result;
          expect(snapshot.status).toBe("running");
          expect(snapshot.history).toEqual([]);
          expect(await s.run(safety).result).toEqual({ state: "occupied", grant });
          expect(s.peer.requests).toHaveLength(1);
          if (safety === "unsafe") {
            await expect(s.run("repeatable", grant).result).rejects.toThrow("Unsafe attempt");
          } else {
            const resumed = s.run("repeatable", grant);
            await s.wait(2, resumed.result);
            expect(s.grants[1]!.requestId).toBe(grant.requestId);
            s.peer.reply(s.grants[1]!.attemptId, { status: 200, body: "reservation-1" });
            expect(await resumed.result).toEqual({
              state: "completed",
              value: { reservation: "reservation-1" },
            });
          }
        });
      }

      for (const boundary of ["beforePark", "beforeBegin"] as const) {
        it(`serializes competing hosts at ${boundary} without duplicate delivery`, async () => {
          const s = scenario();
          const gates = createProtocolRig();
          function run(id: string) {
            let passed = false;
            return s.run("repeatable", undefined, undefined, {
              [boundary]: function* () {
                if (passed) {
                  return;
                }
                passed = true;
                yield* runtime.fromPromise((signal) => gates.send({ id, token: "ready" }, signal));
              },
            });
          }
          const first = run("first");
          await Promise.race([gates.waitForRequests(1), first.result]);
          const second = run("second");
          await Promise.race([gates.waitForRequests(2), first.result, second.result]);
          gates.reply("first", { status: 200, body: "commit" });
          await s.wait(1, first.result);
          gates.reply("second", { status: 200, body: "commit" });
          expect(await second.result).toEqual({ state: "occupied", grant: s.grants[0] });
          expect(s.peer.requests).toHaveLength(1);
          s.peer.reply(s.grants[0]!.attemptId, { status: 200, body: "reservation-1" });
          expect(await first.result).toEqual({
            state: "completed",
            value: { reservation: "reservation-1" },
          });
          expect((await start(() => readJournal(s.journal)).result).history).toHaveLength(1);
        });
      }

      it("recovers an accepted result after acknowledgement loss without executing again", async () => {
        let writes = 0;
        const s = scenario(false, {
          *resolve() {
            return {
              ...v8Serializer,
              encode(value) {
                writes++;
                return v8Serializer.encode(value);
              },
            };
          },
        });
        const transport: Attempts<string, string, string, Y> = {
          begin: s.journal.attempts.begin,
          *settle(grant, outcome) {
            const accepted = yield* s.journal.attempts.settle(grant, outcome);
            writes = 0;
            const duplicate = yield* s.journal.attempts.settle(grant, outcome);
            expect(duplicate).toEqual({ ...accepted, duplicate: true });
            expect(writes).toBe(0);
            yield* runtime.fromPromise(async () => {
              throw new Error("Acceptance acknowledgement lost");
            });
            return accepted;
          },
        };
        const first = s.run("unsafe", undefined, transport);
        await s.wait(1, first.result);
        s.peer.reply(s.grants[0]!.attemptId, { status: 200, body: "reservation-1" });
        await expect(first.result).rejects.toThrow("acknowledgement lost");
        expect(await s.run().result).toEqual({
          state: "completed",
          value: { reservation: "reservation-1" },
        });
        expect(s.peer.requests).toHaveLength(1);
      });

      it("rolls back an unencodable settlement and accepts resubmission without redelivering the effect", async () => {
        const s = scenario();
        const transport: Attempts<string, string, string, Y> = {
          begin: s.journal.attempts.begin,
          *settle(grant, outcome) {
            // A structurally valid Outcome can still contain unencodable extra data.
            const unencodable = { ...outcome, attachment: () => undefined };
            return yield* s.journal.attempts.settle(grant, unencodable);
          },
        };
        const first = s.run("unsafe", undefined, transport);
        await s.wait(1, first.result);
        const grant = s.grants[0]!;
        const before = await start(() => readJournal(s.journal)).result;
        s.peer.reply(grant.attemptId, { status: 200, body: "reservation-1" });
        await expect(first.result).rejects.toBeDefined();
        expect(await start(() => readJournal(s.journal)).result).toEqual(before);
        expect(await start(() => s.journal.attemptControl.inspect(grant)).result).toEqual({
          state: "active",
        });
        s.reconnect();
        expect(await s.run().result).toEqual({ state: "occupied", grant });
        // Resubmit the same provider result under the original grant; do not execute again.
        const accepted = await start(() =>
          s.journal.attempts.settle(grant, { ok: true, value: "reservation-1" }),
        ).result;
        expect(accepted.duplicate).toBe(false);
        expect(await s.run().result).toEqual({
          state: "completed",
          value: { reservation: "reservation-1" },
        });
        s.reconnect();
        const completed = await start(() => readJournal(s.journal)).result;
        const duplicate = await start(() =>
          s.journal.attempts.settle(grant, { ok: true, value: "reservation-1" }),
        ).result;
        expect(duplicate).toEqual({ ...accepted, duplicate: true });
        await expect(
          start(() => s.journal.attempts.settle(grant, { ok: true, value: "different" })).result,
        ).rejects.toThrow("Conflicting accepted outcome");
        expect(await start(() => readJournal(s.journal)).result).toEqual(completed);
        expect(s.peer.requests).toHaveLength(1);
      });

      it("never executes after a lost grant acknowledgement and leaves the attempt occupied", async () => {
        const s = scenario();
        const transport: Attempts<string, string, string, Y> = {
          *begin(...args) {
            yield* s.journal.attempts.begin(...args);
            throw new Error("Grant acknowledgement lost");
          },
          settle: s.journal.attempts.settle,
        };
        await expect(s.run("repeatable", undefined, transport).result).rejects.toThrow(
          "Grant acknowledgement lost",
        );
        expect((await s.run("repeatable").result).state).toBe("occupied");
        expect(s.peer.requests).toEqual([]);
      });
    });
  }
});
