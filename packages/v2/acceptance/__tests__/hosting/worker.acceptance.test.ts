import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createRecovery } from "@sweatpan.ts/durable";
import { createHosting, installGuestRetention } from "@sweatpan.ts/hosting";
import { createSqliteJournalRig, createWorkerGuestRig, readJournal } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { Work } from "@standard-durability/core";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task;
  }
  it(`${runtime.name}: independent failure releases a lost close acknowledgement during finalization`, async () => {
    const failure = new AbortController();
    let dropped!: () => void;
    const closeLost = new Promise<void>((resolve) => {
      dropped = resolve;
    });
    let physicalCloses = 0;
    let logicalCleanups = 0;
    const worker = createWorkerGuestRig<unknown, string, Y>({
      runtime,
      failure: failure.signal,
      *acquire() {
        yield* runtime.composition.ensure(function* () {
          physicalCloses++;
        });
        return createScopedGuest(function* (scope) {
          yield* scope.ensure(function* () {
            logicalCleanups++;
          });
          yield "pending";
        });
      },
      response(response) {
        if (response.kind === "closed") {
          dropped();
          return undefined;
        }
        return response;
      },
    });
    onTestFinished(() => {
      failure.abort(new Error("test disposal"));
      return worker.close();
    });
    const task = start(function* () {
      const guest = yield* worker.acquire();
      yield* runtime.composition.ensure(() => guest.close());
      return yield* guest.start();
    });
    await Promise.race([closeLost, task.result]);
    const stopping = task.cancel();
    // Native scope cancellation alone cannot interrupt an Effect finalizer.
    failure.abort(new Error("close acknowledgement abandoned"));
    await stopping;
    await expect(task.result).rejects.toBeDefined();
    expect(worker.terminations).toBe(1);
    expect(physicalCloses).toBe(1);
    expect(logicalCleanups).toBe(0);
    expect(worker.commands.map((command) => command.action)).toEqual(["start", "close"]);
  });

  it(`${runtime.name}: overlapping next command is discarded while advancement is in flight`, async () => {
    const failure = new AbortController();
    let entered!: () => void;
    const advancing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const allowed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let disposed!: () => void;
    const serverClosed = new Promise<void>((resolve) => {
      disposed = resolve;
    });
    let advances = 0;
    const worker = createWorkerGuestRig<unknown, string, Y>({
      runtime,
      failure: failure.signal,
      *acquire() {
        yield* runtime.composition.ensure(function* () {
          disposed();
        });
        const guest = createScopedGuest(function* () {
          advances++;
          yield "first";
          advances++;
          yield "second";
        });
        return {
          ...guest,
          *start() {
            entered();
            yield* runtime.fromPromise(() => allowed);
            return yield* guest.start();
          },
        };
      },
    });
    onTestFinished(() => {
      release();
      failure.abort(new Error("test disposal"));
      return worker.close();
    });
    const task = start(function* () {
      const guest = yield* worker.acquire();
      yield* runtime.composition.ensure(() => guest.close());
      return yield* guest.start();
    });
    await Promise.race([advancing, task.result]);
    await worker.inject("worker-0", {
      incarnation: "worker-0",
      sequence: 1,
      action: "resume",
      outcome: { ok: true, value: "early" },
    });
    release();
    await serverClosed;
    failure.abort(new Error("peer protocol failed"));
    await expect(task.result).rejects.toThrow("peer protocol failed");
    expect(advances).toBe(1);
    expect(worker.responses).toEqual([]);
    expect(worker.terminations).toBe(1);
  });

  for (const cancel of [false, true]) {
    it(`${runtime.name}: serialized Guest recovers after lost resume response and ${cancel ? "cancels with joined cleanup" : "completes"}`, async () => {
      const store = createSqliteJournalRig<unknown, string, unknown, string, unknown, Y>({
        program: "worker-program",
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      let notifyLost!: () => void;
      const lost = new Promise<void>((resolve) => {
        notifyLost = resolve;
      });
      let dropped = false;
      let physicalCloses = 0;
      let logicalCleanups = 0;
      const worker = createWorkerGuestRig<unknown, string, Y, unknown, string>({
        runtime,
        *acquire() {
          yield* runtime.composition.ensure(function* () {
            physicalCloses++;
          });
          return createScopedGuest(function* (scope) {
            yield* scope.ensure(function* () {
              logicalCleanups++;
              yield "release";
            });
            const reservation = yield "reserve";
            const approval = yield "approve";
            return { reservation, approval };
          });
        },
        response(response) {
          if (!dropped && response.kind === "turn" && response.sequence === 1) {
            dropped = true;
            notifyLost();
            return undefined;
          }
          return response;
        },
      });
      onTestFinished(() => worker.close());
      const deliveries: string[] = [];
      function assembly() {
        const journal = store.open();
        const recovery = createRecovery(runtime.composition, {
          name: "worker-recovery",
          program: "worker-program",
          matches: isDeepStrictEqual,
          acquire: worker.acquire,
        });
        const host = createHosting(runtime.composition, {
          name: "worker-host",
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          *handle(request) {
            deliveries.push(request);
            return {
              ok: true as const,
              value: { id: "hold-1", bytes: new Uint8Array([1, 2]), absent: undefined },
            };
          },
        });
        function* install() {
          yield* installGuestRetention(runtime.composition, host, recovery, journal);
          yield* host.around({
            *deliveryMode([request]) {
              return request === "reserve" ? "execute" : "wait";
            },
          });
        }
        return { journal, host, install };
      }
      const first = assembly();
      const interrupted = start(function* () {
        yield* first.install();
        return yield* first.host.operations.run();
      });
      await Promise.race([lost, interrupted.result]);
      expect(dropped).toBe(true);
      await interrupted.cancel();
      expect(physicalCloses).toBe(1);
      expect(logicalCleanups).toBe(0);
      expect(worker.commands.map((command) => command.action)).toEqual(["start", "resume"]);
      expect(deliveries).toEqual(["reserve"]);
      store.reopen();
      const second = assembly();
      const result = await start(function* () {
        yield* second.install();
        const wait = yield* second.host.operations.run();
        if (wait.state !== "waiting") {
          throw new Error("Expected approval wait");
        }
        expect(wait.pending.request).toBe("approve");
        if (cancel) {
          yield* second.host.operations.cancel(wait.pending.id, "external cancellation");
        } else {
          yield* second.host.operations.answer(wait.grant, { ok: true, value: "approved" });
        }
        const cleanup = yield* second.host.operations.run();
        if (cleanup.state !== "waiting") {
          throw new Error("Expected cleanup wait");
        }
        expect(cleanup.pending.request).toBe("release");
        expect(cleanup.pending.scope?.phase).toBe("cleanup");
        return cleanup;
      }).result;
      expect(logicalCleanups).toBe(1);
      expect(deliveries).toEqual(["reserve"]);
      store.reopen();
      const third = assembly();
      const terminal = await start(function* () {
        yield* third.install();
        const cleanup = yield* third.host.operations.run();
        if (cleanup.state !== "waiting") {
          throw new Error("Expected recovered cleanup");
        }
        expect(cleanup.grant).toEqual(result.grant);
        yield* third.host.operations.answer(cleanup.grant, { ok: true, value: "released" });
        return yield* third.host.operations.run();
      }).result;
      if (cancel) {
        expect(terminal).toEqual({
          state: "cancelled",
          reason: "external cancellation",
          failure: undefined,
        });
        expect(worker.commands.some((command) => command.action === "cancel")).toBe(true);
      } else {
        expect(terminal).toEqual({
          state: "completed",
          value: {
            reservation: { id: "hold-1", bytes: new Uint8Array([1, 2]), absent: undefined },
            approval: "approved",
          },
        });
      }
      expect(deliveries).toEqual(["reserve"]);
      expect(physicalCloses).toBe(worker.terminations);
      expect(
        worker.responses.filter((response) => response.kind === "closed").length,
      ).toBeGreaterThan(0);
      const saved = await start(() => readJournal(third.journal)).result;
      expect(saved.history.filter((entry) => entry.request === "reserve")).toHaveLength(1);
    });
  }
  it(`${runtime.name}: duplicate command is fenced before a second Guest advancement`, async () => {
    let advanced = 0;
    const worker = createWorkerGuestRig<unknown, string, Y>({
      runtime,
      *acquire() {
        return createScopedGuest(function* () {
          advanced++;
          yield "first";
          advanced++;
          yield "second";
        });
      },
      command(command) {
        return command.action === "resume" ? { ...command, sequence: 0 } : command;
      },
    });
    onTestFinished(() => worker.close());
    await expect(
      start(function* () {
        const guest = yield* worker.acquire();
        yield* runtime.composition.ensure(() => guest.close());
        expect(yield* guest.start()).toMatchObject({ kind: "suspended", request: "first" });
        return yield* guest.resume({ ok: true, value: "reply" });
      }).result,
    ).rejects.toThrow("Mismatched Guest response");
    expect(advanced).toBe(1);
    expect(worker.responses[1]).toMatchObject({
      kind: "error",
      message: "Stale or unavailable Guest command",
    });
    expect(worker.terminations).toBe(1);
  });
  for (const mismatch of ["incarnation", "sequence"] as const) {
    it(`${runtime.name}: mismatched ${mismatch} response fences the proxy without logical cleanup`, async () => {
      let cleanups = 0;
      const worker = createWorkerGuestRig<unknown, string, Y>({
        runtime,
        *acquire() {
          return createScopedGuest(function* (scope) {
            yield* scope.ensure(function* () {
              cleanups++;
            });
            yield "request";
          });
        },
        response(response) {
          return mismatch === "incarnation"
            ? { ...response, incarnation: "previous" }
            : { ...response, sequence: Number(response.sequence) + 1 };
        },
      });
      onTestFinished(() => worker.close());
      await expect(
        start(function* () {
          const guest = yield* worker.acquire();
          yield* runtime.composition.ensure(() => guest.close());
          yield* runtime.composition.catchError(
            () => guest.start(),
            function* (error) {
              expect(String(error)).toContain("Mismatched Guest response");
            },
          );
          return yield* guest.start();
        }).result,
      ).rejects.toThrow("Worker Guest is unavailable");
      expect(worker.commands).toHaveLength(1);
      expect(worker.terminations).toBe(1);
      expect(cleanups).toBe(0);
    });
  }
});
