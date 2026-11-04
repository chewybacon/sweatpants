import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { Work } from "@standard-durability/core";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createHostedActivation,
  createHosting,
  createJournalPresentation,
} from "@sweatpan.ts/hosting";
import {
  createHostedRecovery,
  createProtocolRig,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: lost publication recovers accepted output and registered waits without acquiring or delivering`, async () => {
    const store = createSqliteJournalRig<string, string, string, string, unknown, Y>({
      program: "publication",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const peer = createProtocolRig();
    let acquisitions = 0;
    let deliveries = 0;
    let disposals = 0;
    function start<T>(work: Work<T, Y>) {
      const task = runtime.start(work);
      void task.result.catch(() => undefined);
      onTestFinished(() => task.cancel());
      return task.result;
    }
    function assemble() {
      const journal = store.open();
      const presentation = createJournalPresentation(runtime.composition, "presentation", journal);
      return {
        journal,
        read: presentation.operations.read,
        activate() {
          const activation = createHostedActivation(runtime, {
            *run(emit: (value: string) => void) {
              const recovery = createHostedRecovery<string, string, Y, string, string>(runtime, {
                name: "publication-recovery",
                program: "publication",
                matches: isDeepStrictEqual,
                *acquire() {
                  acquisitions++;
                  yield* runtime.composition.ensure(function* () {
                    disposals++;
                  });
                  return createScopedGuest(function* () {
                    const response: unknown = yield "model";
                    yield "question";
                    return String(response);
                  });
                },
              });
              const host = createHosting(runtime.composition, {
                name: "publication-host",
                journal,
                recovery: recovery.operations,
                attempts: journal.attempts,
                interactions: journal.interactions,
                *handle(request) {
                  expect(request).toBe("model");
                  deliveries++;
                  emit("provisional delta");
                  const response = yield* runtime.fromPromise((signal) =>
                    peer.send({ id: "model", token: "inference" }, signal),
                  );
                  return { ok: true as const, value: response.body };
                },
              });
              yield* host.around({
                *deliveryMode([request]) {
                  return request === "question" ? "wait" : "execute";
                },
              });
              return yield* host.operations.run();
            },
            present() {
              expect(disposals).toBe(acquisitions);
              throw new Error("Connection lost before publication");
            },
          });
          onTestFinished(() => activation.cancel());
          return activation;
        },
      };
    }
    let app = assemble();
    const initial = await start(() => app.read());
    expect(initial.state).toEqual({ status: "running", revision: 0 });
    expect(initial.entries).toEqual([]);
    expect(acquisitions).toBe(0);
    const activation = app.activate();
    await Promise.race([peer.waitForRequests(1), activation.result]);
    peer.reply("model", { status: 200, body: "accepted answer" });
    await expect(activation.result).rejects.toThrow("Connection lost before publication");
    const acquiredAtLoss = acquisitions;
    store.reopen();
    app = assemble();
    const page = await start(() => app.read(initial.after, 1));
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.outcome).toEqual({ ok: true, value: "accepted answer" });
    expect(page.caughtUp).toBe(true);
    expect(page.state.status).toBe("running");
    if (page.state.status !== "running" || page.state.interaction?.state !== "waiting") {
      throw new Error("Expected retained registered wait");
    }
    const grant = page.state.interaction.grant;
    expect(page.state.pending?.request).toBe("question");
    expect(acquisitions).toBe(acquiredAtLoss);
    expect(deliveries).toBe(1);
    // Applying a page and losing its acknowledgement repeats receipts, not effects.
    const rendered = new Map(page.entries.map((entry) => [entry.receipt, entry.outcome]));
    store.reopen();
    app = assemble();
    const repeated = await start(() => app.read(initial.after, 1));
    expect(repeated).toEqual(page);
    for (const entry of repeated.entries) {
      rendered.set(entry.receipt, entry.outcome);
    }
    expect(rendered.size).toBe(1);
    expect(acquisitions).toBe(acquiredAtLoss);
    const current = await start(() => app.read(page.after));
    expect(current.entries).toEqual([]);
    expect(current.state).toEqual(page.state);
    for (const cursor of [
      { ...page.after, execution: "foreign" },
      { ...page.after, receipt: "divergent" },
      { ...page.after, position: page.after.position + 1 },
      { ...page.after, position: -1 },
      { ...page.after, position: 0.5 },
    ]) {
      await expect(start(() => app.read(cursor))).rejects.toThrow();
    }
    await expect(start(() => app.read(undefined, 0))).rejects.toThrow("page limit");
    await start(() => app.journal.interactions.answer(grant, { ok: true, value: "yes" }));
    const answered = await start(() => app.read(page.after, 1));
    expect(answered.entries).toHaveLength(1);
    expect(answered.state.status === "running" && answered.state.interaction).toBeUndefined();
    expect(acquisitions).toBe(acquiredAtLoss);
    // Terminal acceptance can also precede a failed publication.
    await expect(app.activate().result).rejects.toThrow("Connection lost before publication");
    expect(deliveries).toBe(1);
    const terminalAcquisitions = acquisitions;
    store.reopen();
    app = assemble();
    const terminal = await start(() => app.read(answered.after));
    expect(terminal.entries).toEqual([]);
    expect(terminal.state).toMatchObject({ status: "completed", value: "accepted answer" });
    expect(acquisitions).toBe(terminalAcquisitions);
    const prefix = await start(() => app.read(undefined, 1));
    expect(prefix.caughtUp).toBe(false);
    const suffix = await start(() => app.read(prefix.after, 1));
    expect(suffix.caughtUp).toBe(true);
    expect(suffix.entries[0]?.sequence).toBe(1);
    expect(peer.requests).toHaveLength(1);
  });
  it(`${runtime.name}: presentation preserves invalidation and never grants a new participant authority`, async () => {
    const store = createSqliteJournalRig<string, string, string, string, unknown, Y>({
      program: "revoked-presentation",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const journal = store.open();
    let acquisitions = 0;
    const recovery = createHostedRecovery<string, string, Y, string, string>(runtime, {
      name: "revoked-recovery",
      program: "revoked-presentation",
      matches: isDeepStrictEqual,
      *acquire() {
        acquisitions++;
        return createScopedGuest(function* () {
          yield "question";
          return "done";
        });
      },
    });
    const host = createHosting(runtime.composition, {
      name: "revoked-host",
      journal,
      recovery: recovery.operations,
      attempts: journal.attempts,
      interactions: journal.interactions,
      *handle() {
        throw new Error("Participant handler must not execute");
      },
    });
    const task = runtime.start(function* () {
      yield* host.around({
        *deliveryMode() {
          return "wait";
        },
      });
      const result = yield* host.operations.run();
      if (result.state !== "waiting") {
        throw new Error("Expected wait");
      }
      yield* host.operations.invalidate(result.grant, "expired");
      return result.grant;
    });
    onTestFinished(() => task.cancel());
    const grant = await task.result;
    const acquired = acquisitions;
    store.reopen();
    const reopened = store.open();
    const presentation = createJournalPresentation(
      runtime.composition,
      "revoked-presentation",
      reopened,
    );
    const read = runtime.start(function* () {
      const before = yield* reopened.read();
      const page = yield* presentation.operations.read();
      expect(page.state).toMatchObject({
        status: "running",
        interaction: { state: "invalidated", grant, reason: "expired" },
      });
      expect(page.state.revision).toBe(before.revision);
      expect((yield* reopened.read()).revision).toBe(before.revision);
      return page;
    });
    onTestFinished(() => read.cancel());
    await read.result;
    expect(acquisitions).toBe(acquired);
    const late = runtime.start(() =>
      reopened.interactions.answer(grant, { ok: true, value: "late" }),
    );
    onTestFinished(() => late.cancel());
    await expect(late.result).rejects.toThrow();
  });
});
