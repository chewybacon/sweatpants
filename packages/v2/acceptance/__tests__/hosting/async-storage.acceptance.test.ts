import { expect, it, onTestFinished } from "vitest";
import { isDeepStrictEqual } from "node:util";
import type { Work } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createJournalBinding, createRecovery, type AcceptedHistory } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting } from "@sweatpan.ts/hosting";
import {
  createJournalStorageRig,
  createProtocolRig,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: host disposal rolls back a suspended grant and joins storage close before retry`, async () => {
    function start<T>(work: Work<T, Y>) {
      const execution = runtime.start(work);
      void execution.result.catch(() => undefined);
      onTestFinished(() => execution.cancel());
      return execution;
    }
    const storage = createJournalStorageRig(runtime, "booking");
    const journal = createJournalBinding<string, string, string, string, unknown, Y>(
      { program: "booking", equals: isDeepStrictEqual },
      storage.backend,
      storage.id,
    );
    const provider = createProtocolRig();
    const recovery = createRecovery(runtime.composition, {
      name: "async-recovery",
      program: "booking",
      matches: isDeepStrictEqual,
      *acquire() {
        return createScopedGuest(function* () {
          return (yield "reserve") as string;
        });
      },
    });
    const host = createHosting(runtime.composition, {
      name: "async-host",
      journal,
      recovery: recovery.operations,
      attempts: journal.attempts,
      *handle() {
        const reply = yield* runtime.fromPromise((signal) =>
          provider.send({ id: "reserve", token: "booking" }, signal),
        );
        return { ok: true as const, value: reply.body };
      },
    });
    storage.pause("setRequest");
    const first = start(() => host.operations.run());
    await Promise.race([storage.peer.waitForRequests(1), first.result]);
    expect(storage.peer.requests[0]!.id).toBe("setRequest");
    storage.pause("close");
    let closed = false;
    const cancelled = first.cancel().then(() => {
      closed = true;
    });
    await storage.peer.waitForRequests(2);
    expect(closed).toBe(false);
    expect(storage.peer.aborted).toContain("setRequest");
    storage.peer.reply("close", { status: 200, body: "closed" });
    await cancelled;
    expect(provider.requests).toEqual([]);
    const before = await start(() => journal.read()).result;
    expect(before.status).toBe("running");
    expect(before.cancellation).toBeUndefined();
    expect(before.frontier.position).toBe(0);

    const second = start(() => host.operations.run());
    await Promise.race([provider.waitForRequests(1), second.result]);
    provider.reply("reserve", { status: 200, body: "hold" });
    await expect(second.result).resolves.toEqual({ state: "completed", value: "hold" });
    // A captured empty prefix stays empty even after later commits.
    expect(await start(() => before.history.read(0, 128)).result).toEqual([]);
    expect((await start(() => journal.read()).result).frontier.position).toBe(1);
    expect(storage.events.slice(-2)).toEqual(["released", "acknowledge"]);
  });
  it(`${runtime.name}: cancellation wins while replay awaits a history page and stale recovery cannot publish`, async () => {
    function start<T>(work: Work<T, Y>) {
      const execution = runtime.start(work);
      void execution.result.catch(() => undefined);
      onTestFinished(() => execution.cancel());
      return execution;
    }
    const storage = createJournalStorageRig(runtime, "approval");
    const journal = createJournalBinding<string, string, string, string, unknown, Y>(
      { program: "approval", equals: isDeepStrictEqual },
      storage.backend,
      storage.id,
    );
    const provider = createProtocolRig();
    const recovery = createRecovery(runtime.composition, {
      name: "page-recovery",
      program: "approval",
      matches: isDeepStrictEqual,
      *acquire() {
        return createScopedGuest(function* () {
          yield "reserve";
          return (yield "approve") as string;
        });
      },
    });
    let reservations = 0;
    const host = createHosting(runtime.composition, {
      name: "page-host",
      journal,
      recovery: recovery.operations,
      attempts: journal.attempts,
      *handle(request) {
        if (request === "reserve") {
          reservations++;
          return { ok: true as const, value: "hold" };
        }
        const reply = yield* runtime.fromPromise((signal) =>
          provider.send({ id: "approve", token: "approval" }, signal),
        );
        return { ok: true as const, value: reply.body };
      },
    });
    const first = start(() => host.operations.run());
    await Promise.race([provider.waitForRequests(1), first.result]);
    await first.cancel();
    const waiting = await start(() => journal.read()).result;
    if (waiting.status !== "running" || !waiting.pending) {
      throw new Error("Expected approval boundary");
    }
    storage.pause("history");
    const stale = start(() => host.operations.run());
    await Promise.race([storage.peer.waitForRequests(1), stale.result]);
    await start(() => journal.cancellation.request(waiting.pending!.id, "deadline")).result;
    storage.peer.reply("history", { status: 200, body: "page" });
    await expect(stale.result).resolves.toEqual({
      state: "cancelled",
      reason: "deadline",
      failure: undefined,
    });
    expect(reservations).toBe(1);
    expect(provider.requests).toHaveLength(1);
    expect(await start(() => waiting.history.read(0, 128)).result).toHaveLength(1);
  });
  it(`${runtime.name}: hosted replay crosses history pages without extending a captured prefix`, async () => {
    const store = createSqliteJournalRig<number, number, number, string>({
      program: "loop",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const stored = store.open();
    const ranges: { from: number; end: number; count: number }[] = [];
    const journal: typeof stored = {
      ...stored,
      *read() {
        const snapshot = yield* stored.read();
        return {
          ...snapshot,
          history: {
            ...snapshot.history,
            *read(from, limit) {
              const entries = yield* snapshot.history.read(from, limit);
              ranges.push({ from, end: snapshot.history.end.position, count: entries.length });
              return entries;
            },
          },
        };
      },
    };
    const recovery = createRecovery(runtime.composition, {
      name: "loop-recovery",
      program: "loop",
      matches: isDeepStrictEqual,
      *acquire() {
        return createScopedGuest(function* () {
          let total = 0;
          for (let index = 0; index < 130; index++) {
            total += (yield index) as number;
          }
          return total;
        });
      },
    });
    let captured: AcceptedHistory<number, number, string, never> | undefined;
    const deliveries: number[] = [];
    const host = createHosting(runtime.composition, {
      name: "loop-host",
      journal,
      recovery: recovery.operations,
      attempts: journal.attempts,
      *handle(request) {
        deliveries.push(request);
        if (request === 128) {
          captured = (yield* stored.read()).history;
        }
        return { ok: true as const, value: 1 };
      },
    });
    const execution = runtime.start(() => host.operations.run());
    onTestFinished(() => execution.cancel());
    await expect(execution.result).resolves.toEqual({ state: "completed", value: 130 });
    expect(deliveries).toEqual(Array.from({ length: 130 }, (_, index) => index));
    expect(ranges.slice(-2)).toEqual([
      { from: 0, end: 130, count: 128 },
      { from: 128, end: 130, count: 2 },
    ]);
    if (!captured) {
      throw new Error("Expected captured history");
    }
    const prefix = captured;
    const inspect = runtime.start(function* () {
      expect(yield* prefix.read(0, 512)).toHaveLength(128);
      expect(yield* prefix.at(128)).toBeUndefined();
      expect(yield* prefix.read(128, 128)).toEqual([]);
    });
    onTestFinished(() => inspect.cancel());
    await inspect.result;
  });
});
