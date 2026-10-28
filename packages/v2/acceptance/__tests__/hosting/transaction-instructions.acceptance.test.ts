import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { composeOperation, type Work, type Operation } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createRecovery, type TransactionInstruction } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting } from "@sweatpan.ts/hosting";
import { createMemoryJournal } from "@sweatpan.ts/storage-memory";
import { createJournalStorageRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution;
  }
  function scenario(handle: Work<string, Y>) {
    const journal = createMemoryJournal<string, string, string, string>({
      program: "transaction-client",
      equals: isDeepStrictEqual,
    });
    const recovery = createRecovery(runtime.composition, {
      name: "instruction-recovery",
      program: "transaction-client",
      matches: isDeepStrictEqual,
      *acquire() {
        return createScopedGuest(function* () {
          return (yield "store") as string;
        });
      },
    });
    const host = createHosting(runtime.composition, {
      name: "instruction-host",
      journal,
      recovery: recovery.operations,
      attempts: journal.attempts,
      *handle() {
        return { ok: true as const, value: yield* handle() };
      },
    });
    return { run: () => start(() => host.operations.run()), journal };
  }

  it(`${runtime.name}: hosted transaction infers its result and composes lazy commit registrations`, async () => {
    const storage = createJournalStorageRig(runtime, "data");
    const events: string[] = [];
    const transactions = storage.backend;
    const s = scenario(function* () {
      const result = yield* transactions.transact(function* (transaction) {
        const tx = {
          ...transaction,
          onCommit: composeOperation(transaction.onCommit, [
            function* ([publish], next) {
              events.push("register");
              yield* next(() => {
                events.push("wrapped");
                publish();
              });
            },
          ]),
        };
        // Construction alone must not register or enter middleware.
        tx.onCommit(() => {
          events.push("unused");
        });
        yield* tx.onCommit(() => {
          events.push("first");
        });
        const root = yield* tx.records.get(storage.id);
        if (!root) {
          throw new Error("Missing data");
        }
        yield* tx.onCommit(() => {
          events.push("second");
        });
        events.push("body");
        return { revision: root.snapshot.revision, source: "data" as const };
      });
      expectTypeOf(result).toEqualTypeOf<{ revision: number; source: "data" }>();
      events.push("acknowledged");
      return result.source;
    });
    await expect(s.run().result).resolves.toEqual({ state: "completed", value: "data" });
    expect(events).toEqual([
      "register",
      "register",
      "body",
      "wrapped",
      "first",
      "wrapped",
      "second",
      "acknowledged",
    ]);
  });

  it(`${runtime.name}: native storage failure discards instruction publications and leaves the hosted attempt occupied`, async () => {
    const storage = createJournalStorageRig(runtime, "data");
    const transactions = storage.backend;
    let published = false;
    const s = scenario(() =>
      transactions.transact(function* (tx) {
        yield* tx.onCommit(() => {
          published = true;
        });
        yield* tx.records.get(storage.id);
        return "done";
      }),
    );
    storage.pause("get");
    const execution = s.run();
    await Promise.race([storage.peer.waitForRequests(1), execution.result]);
    storage.peer.fail("get", new Error("Storage failed"));
    await expect(execution.result).rejects.toThrow("Storage failed");
    expect(published).toBe(false);
    expect(storage.events).toContain("released");
    expect((await s.run().result).state).toBe("occupied");
    expect((await start(() => s.journal.read()).result).frontier.position).toBe(0);
  });

  it(`${runtime.name}: hosted transaction rejects an instruction belonging to another live transaction`, async () => {
    const first = createJournalStorageRig(runtime, "first");
    const second = createJournalStorageRig(runtime, "second");
    const outer = first.backend;
    const inner = second.backend;
    let published = false;
    const s = scenario(() =>
      outer.transact(function* (tx) {
        const foreign = tx.onCommit(() => {
          published = true;
        });
        return yield* inner.transact(function* () {
          yield* foreign;
          return "wrong owner";
        });
      }),
    );
    await expect(s.run().result).rejects.toThrow("outside its owner");
    expect(published).toBe(false);
    expect(first.events).toContain("released");
    expect(second.events).toContain("released");
    expect((await s.run().result).state).toBe("occupied");
  });

  it(`${runtime.name}: a retained registration operation cannot enter a later hosted transaction`, async () => {
    const storage = createJournalStorageRig(runtime, "data");
    const transactions = storage.backend;
    let published = false;
    let retained: Operation<void, TransactionInstruction> | undefined;
    const s = scenario(function* () {
      yield* transactions.transact(function* (tx) {
        retained = tx.onCommit(() => {
          published = true;
        });
        yield* tx.records.get(storage.id);
      });
      return yield* transactions.transact(function* () {
        if (!retained) {
          throw new Error("Missing retained operation");
        }
        yield* retained;
        return "wrong lifetime";
      });
    });
    await expect(s.run().result).rejects.toThrow("registration is closed");
    expect(published).toBe(false);
    expect((await s.run().result).state).toBe("occupied");
  });
});
