import {
  createHostedRecovery as createRecovery,
  createJournalStorageRig,
  readJournal,
} from "@sweatpan.ts/testing";
import { expect, it, onTestFinished } from "vitest";
import { isDeepStrictEqual } from "node:util";
import type { Work } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import { activateJournal, createJournalBinding, type OwnedJournal } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting } from "@sweatpan.ts/hosting";

import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution;
  }
  async function scenario() {
    const storage = createJournalStorageRig(runtime, "parent");
    const parent = createJournalBinding<string, string, string, string, unknown, Y>(
      { program: "parent", equals: isDeepStrictEqual },
      storage.backend,
      storage.id,
    );
    const recovery = createRecovery(runtime, {
      name: "parent-recovery",
      program: "parent",
      matches: isDeepStrictEqual,
      *acquire() {
        return createScopedGuest(function* () {
          return (yield "child") as string;
        });
      },
    });
    const parked = await start(() =>
      activateJournal(runtime.composition, recovery.operations, parent),
    ).result;
    if (parked.state !== "parked") {
      throw new Error("Expected owned call");
    }
    const requestId = parked.pending.id;
    function acquire(projection: string) {
      return parent.ensureChild<string, string, string, string>(requestId, {
        program: "child",
        input: "input",
        outcome: () => ({ ok: true, value: projection }),
      });
    }
    function complete(child: OwnedJournal<string, string, string, string, unknown, Y>) {
      const recovery = createRecovery(runtime, {
        name: "child-recovery",
        program: "child",
        matches: isDeepStrictEqual,
        *acquire() {
          return createScopedGuest(function* () {
            return "done";
          });
        },
      });
      const host = createHosting(runtime.composition, {
        name: "child-host",
        journal: child,
        attempts: child.attempts,
        recovery: recovery.operations,
        *handle() {
          throw new Error("No provider delivery expected");
        },
      });
      return start(() => host.operations.run());
    }
    return {
      storage,
      parent,
      acquire,
      complete,
      resume: () => start(() => activateJournal(runtime.composition, recovery.operations, parent)),
    };
  }

  for (const cancel of [false, true]) {
    it(`${runtime.name}: original owned projection survives reacquisition before commit acknowledgement (cancel: ${cancel})`, async () => {
      const s = await scenario();
      s.storage.pause("acknowledge");
      const original = start(() => s.acquire("original"));
      await Promise.race([s.storage.peer.waitForRequests(1), original.result]);
      // Database ownership is released; the first caller has not received its result.
      const replacement = await start(() => s.acquire("replacement")).result;
      if (cancel) {
        await original.cancel();
        expect(s.storage.peer.aborted).toContain("acknowledge");
      }
      await expect(s.complete(replacement.journal).result).resolves.toEqual({
        state: "completed",
        value: "done",
      });
      await expect(s.resume().result).resolves.toEqual({ state: "completed", value: "original" });
      if (!cancel) {
        s.storage.peer.reply("acknowledge", { status: 200, body: "committed" });
        expect((await original.result).link).toEqual(replacement.link);
      }
    });
  }

  it(`${runtime.name}: rolled-back acquisition does not retain its staged projection`, async () => {
    const s = await scenario();
    s.storage.pause("commit");
    const original = start(() => s.acquire("discarded"));
    await Promise.race([s.storage.peer.waitForRequests(1), original.result]);
    await original.cancel();
    expect(s.storage.peer.aborted).toContain("commit");
    const acquired = await start(() => s.acquire("committed")).result;
    await expect(s.complete(acquired.journal).result).resolves.toEqual({
      state: "completed",
      value: "done",
    });
    await expect(s.resume().result).resolves.toEqual({ state: "completed", value: "committed" });
  });

  for (const boundary of ["set", "append"]) {
    it(`${runtime.name}: disposal during owned terminal ${boundary} rolls back child and parent before hosted recovery`, async () => {
      const s = await scenario();
      const child = await start(() => s.acquire("original")).result;
      const beforeParent = await start(() => readJournal(s.parent)).result;
      const beforeChild = await start(() => readJournal(child.journal)).result;
      s.storage.pause(boundary);
      const interrupted = s.complete(child.journal);
      await Promise.race([s.storage.peer.waitForRequests(1), interrupted.result]);
      await interrupted.cancel();
      expect(s.storage.peer.aborted).toContain(boundary);
      expect(await start(() => readJournal(s.parent)).result).toEqual(beforeParent);
      expect(await start(() => readJournal(child.journal)).result).toEqual(beforeChild);
      const rebound = await start(() => s.acquire("replacement")).result;
      await expect(s.complete(rebound.journal).result).resolves.toEqual({
        state: "completed",
        value: "done",
      });
      await expect(s.resume().result).resolves.toEqual({ state: "completed", value: "original" });
      expect((await start(() => readJournal(s.parent)).result).history).toHaveLength(1);
    });
  }
});
