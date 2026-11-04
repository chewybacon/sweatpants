import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import {
  createActivationIntents,
  type OwnedChild,
  type ResolutionGrant,
} from "@sweatpan.ts/durable";
import { createActivationReconciler } from "@sweatpan.ts/deployment";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { childHostingResult, createHosting, createJournalPresentation } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import {
  createHostedRecovery,
  createProtocolRig,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";
type Request =
  | {
      readonly kind: "signup" | "reserve";
    }
  | {
      readonly kind: "approve" | "commit" | "release";
      readonly resource: string;
    }
  | {
      readonly kind: "repair";
      readonly resource: string;
      readonly failure: string;
    };
const repairDecision = z.object({
  action: z.enum(["confirmed-released", "waive"]),
  evidence: z.string().min(1),
});
function* exchange(request: Request): Operation<unknown, Request> {
  return yield request;
}
// A concrete saga assembly, not a new failure interpreter or repair registry.
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task;
  }
  function scenario(loseAccepted?: "reserve" | "commit" | "release", resourceCount = 1) {
    const store = createSqliteJournalRig<string, Request, unknown, string, unknown, Y>({
      program: "signup-owner-v1",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const peer = createProtocolRig();
    let acquisitions = 0;
    let lost = false;
    // A cooperative boundary before commit delivery, used to test the race precisely.
    let pauseCommit = false;
    function assemble() {
      const parent = store.open();
      type Child = OwnedChild<string, Request, unknown, string, unknown, Y>;
      let child: Child | undefined;
      function* bindChild(requestId: string) {
        child = yield* parent.ensureChild<string, Request, unknown, string>(requestId, {
          program: "signup-v1",
          input: { resourceCount },
          outcome: (value) => ({ ok: true, value }),
        });
        return child;
      }
      function childHost(owned: Child) {
        const recovery = createHostedRecovery<string, Request, Y, unknown, string>(runtime, {
          name: "signup-recovery",
          program: "signup-v1",
          matches: isDeepStrictEqual,
          *acquire() {
            acquisitions++;
            const { resourceCount: count } = z
              .object({ resourceCount: z.number().int().positive() })
              .parse(owned.link.input);
            return createScopedGuest(function* (scope) {
              let committed = false;
              const resources: string[] = [];
              for (let index = 0; index < count; index++) {
                resources.push(
                  yield* scope.critical(function* () {
                    const id = z.string().parse(yield* exchange({ kind: "reserve" }));
                    yield* scope.ensure(function* () {
                      if (committed) {
                        return;
                      }
                      const released = z
                        .enum(["released", "denied"])
                        .parse(yield* exchange({ kind: "release", resource: id }));
                      if (released === "denied") {
                        // Accepted business failure is preserved. Cleanup explicitly parks
                        // before settlement instead of throwing away its repair obligation.
                        repairDecision.parse(
                          yield* exchange({
                            kind: "repair",
                            resource: id,
                            failure: "Release denied",
                          }),
                        );
                      }
                    });
                    return id;
                  }),
                );
              }
              const resource = resources[0]!;
              z.literal("approved").parse(yield* exchange({ kind: "approve", resource }));
              // Entering this region permits commit even if cancellation follows.
              // It cannot decide the outcome of an external commit with a lost reply.
              yield* scope.critical(function* () {
                z.literal("committed").parse(yield* exchange({ kind: "commit", resource }));
                committed = true;
              });
              return "active";
            });
          },
        });
        return createHosting(runtime.composition, {
          name: "signup-host",
          journal: owned.journal,
          recovery: recovery.operations,
          attempts: owned.journal.attempts,
          interactions: owned.journal.interactions,
          *handle(request: Request): Operation<Outcome<unknown, string>, Y> {
            const response = yield* runtime.fromPromise((signal) =>
              peer.send({ id: request.kind, token: JSON.stringify(request) }, signal),
            );
            return { ok: true, value: response.body };
          },
        });
      }
      function* runChild(owned: Child) {
        const host = childHost(owned);
        yield* host.around({
          operations: {
            deliveryMode: () =>
              function* (request) {
                return request.kind === "approve" || request.kind === "repair" ? "wait" : "execute";
              },
            activate: (next) =>
              function* (...args) {
                const boundary = yield* next(...args);
                // Stop this test owner at a persisted protected boundary, before any
                // attempt grant or external delivery. The next owner may continue.
                if (
                  pauseCommit &&
                  boundary.state === "parked" &&
                  boundary.pending.request.kind === "commit"
                ) {
                  throw new Error("Paused before commit delivery");
                }
                return boundary;
              },
          },
        });
        yield* host.attempts.around({
          operations: {
            settle: (next) =>
              function* (grant, outcome) {
                const accepted = yield* next(grant, outcome);
                if (!lost && accepted.entry.request.kind === loseAccepted) {
                  lost = true;
                  throw new Error("Owner lost after acceptance");
                }
                return accepted;
              },
          },
        });
        return childHostingResult(yield* host.operations.run());
      }
      function* run() {
        const recovery = createHostedRecovery<string, Request, Y, unknown, string>(runtime, {
          name: "signup-owner-recovery",
          program: "signup-owner-v1",
          matches: isDeepStrictEqual,
          *acquire() {
            acquisitions++;
            return createScopedGuest(function* () {
              return z.string().parse(yield* exchange({ kind: "signup" }));
            });
          },
        });
        const host = createHosting(runtime.composition, {
          name: "signup-owner",
          journal: parent,
          recovery: recovery.operations,
          attempts: parent.attempts,
          *handle(): Operation<Outcome<unknown, string>, Y> {
            throw new Error("Parent must route signup to its owned child");
          },
        });
        yield* host.around({
          operations: {
            child: () =>
              function* (pending) {
                const owned = yield* bindChild(pending.id);
                return { id: owned.link.childId, run: () => runChild(owned) };
              },
          },
        });
        return yield* host.operations.run();
      }
      const reconciler = createActivationReconciler(runtime.composition, "signup-reconcile", {
        intents: createActivationIntents(runtime.composition, "signup-intents", store.activations),
        run,
      });
      return {
        run: () => start(run),
        reconcile: () => start(() => reconciler.operations.reconcile()).result,
        async observe() {
          return start(function* () {
            const before = yield* parent.read();
            const intent = yield* store.activations.read();
            if (!child) {
              if (before.status !== "running" || !before.children?.[0]) {
                throw new Error("No active child to observe");
              }
              // Rebind an existing owned link, not create or advance a workflow.
              yield* bindChild(before.children[0].requestId);
            }
            const root = yield* createJournalPresentation(
              runtime.composition,
              "owner-view",
              parent,
            ).operations.read();
            const leaf = yield* createJournalPresentation(
              runtime.composition,
              "signup-view",
              child!.journal,
            ).operations.read();
            expect((yield* parent.read()).revision).toBe(before.revision);
            expect(yield* store.activations.read()).toEqual(intent);
            return { root, leaf };
          }).result;
        },
        cancel: () =>
          start(function* () {
            const snapshot = yield* parent.read();
            const requestId =
              snapshot.status === "running"
                ? (snapshot.pending?.id ?? snapshot.cancellation?.requestId)
                : snapshot.cancellation?.requestId;
            if (!requestId) {
              throw new Error("No cancellation boundary");
            }
            return yield* parent.cancellation.request(requestId, "signup cancelled");
          }).result,
        answer: (grant: ResolutionGrant, value: unknown) =>
          start(function* () {
            if (!child) {
              throw new Error("Observe or drive before answering");
            }
            const request = yield* child.journal.interactions.request(grant);
            if (request.kind !== "approve") {
              throw new Error("Not an approval interaction");
            }
            return yield* child.journal.interactions.answer(grant, {
              ok: true,
              value: z.literal("approved").parse(value),
            });
          }).result,
        repair: (grant: ResolutionGrant, value: unknown, operator: boolean) =>
          start(function* () {
            if (!operator) {
              throw new Error("Repair authorization required");
            }
            if (!child) {
              throw new Error("Observe or drive before repairing");
            }
            const request = yield* child.journal.interactions.request(grant);
            if (request.kind !== "repair") {
              throw new Error("Not a repair obligation");
            }
            const decision = repairDecision.parse(value);
            return yield* child.journal.interactions.answer(grant, { ok: true, value: decision });
          }).result,
      };
    }
    let app = assemble();
    return {
      peer,
      store,
      get app() {
        return app;
      },
      get acquisitions() {
        return acquisitions;
      },
      set pauseCommit(value: boolean) {
        pauseCommit = value;
      },
      reopen() {
        store.reopen();
        app = assemble();
      },
      async begin() {
        const task = app.run();
        for (let index = 0; index < resourceCount; index++) {
          await Promise.race([peer.waitForRequests(index + 1), task.result]);
          peer.reply("reserve", { status: 200, body: index === 0 ? "draft-1" : "workspace-2" });
        }
        return task.result;
      },
    };
  }
  function waiting(
    view: Awaited<ReturnType<ReturnType<typeof scenario>["app"]["observe"]>>["leaf"],
  ) {
    if (view.state.status !== "running" || view.state.interaction?.state !== "waiting") {
      throw new Error("Expected registered participant wait");
    }
    return view.state.interaction.grant;
  }
  it.each(["confirmed-released", "waive"] as const)(
    `${runtime.name}: cancelled signup retains required repair and its parent across reopen (%s)`,
    async (action) => {
      const s = scenario(action === "confirmed-released" ? "release" : undefined);
      let resource: "reserved" | "absent" = "reserved";
      await s.begin();
      const approval = waiting((await s.app.observe()).leaf);
      await s.app.cancel();
      expect((await s.app.observe()).root.state).toMatchObject({
        status: "running",
        cancellationRequested: { reason: "signup cancelled" },
      });
      const unwinding = s.app.run();
      await Promise.race([s.peer.waitForRequests(2), unwinding.result]);
      s.peer.reply("release", { status: 200, body: "denied" });
      if (action === "confirmed-released") {
        await expect(unwinding.result).rejects.toThrow("Owner lost after acceptance");
        s.reopen();
        // The known failure was accepted before a repair request was published.
        // Replay reconstructs the obligation; neither child nor parent settled.
        expect((await s.app.observe()).root.state.status).toBe("running");
        expect(await s.app.run().result).toMatchObject({ state: "child", reason: "waiting" });
      } else {
        expect(await unwinding.result).toMatchObject({ state: "child", reason: "waiting" });
      }
      const acquired = s.acquisitions;
      s.reopen();
      const observed = await s.app.observe();
      expect(s.acquisitions).toBe(acquired);
      expect(observed.root.state).toMatchObject({
        status: "running",
        cancellationRequested: { reason: "signup cancelled" },
      });
      expect(observed.leaf.state).toMatchObject({
        status: "running",
        cancellation: { reason: "signup cancelled" },
        pending: {
          request: { kind: "repair", resource: "draft-1", failure: "Release denied" },
          scope: { phase: "cleanup" },
        },
      });
      expect(observed.leaf.entries.map((entry) => entry.request.kind)).toEqual([
        "reserve",
        "release",
      ]);
      const failedRelease = observed.leaf.entries[1]!;
      expect(failedRelease.outcome).toEqual({ ok: true, value: "denied" });
      const grant = waiting(observed.leaf);
      await s.app.cancel();
      expect(waiting((await s.app.observe()).leaf)).toEqual(grant);
      await expect(s.app.answer(approval, "approved")).rejects.toThrow("revoked");
      const decision = { action, evidence: "operator-ticket-7" };
      await expect(s.app.repair(grant, decision, false)).rejects.toThrow("authorization");
      await expect(
        s.app.repair({ ...grant, resolutionId: "foreign" }, decision, true),
      ).rejects.toThrow("authority");
      await expect(s.app.repair(grant, { action, evidence: "" }, true)).rejects.toThrow();
      // Stable participant waits may clear scheduling intent without losing the obligation.
      expect(await s.app.reconcile()).toMatchObject({ state: "driven", acknowledged: true });
      expect(await s.app.reconcile()).toEqual({ state: "idle" });
      expect(resource).toBe("reserved");
      if (action === "confirmed-released") {
        resource = "absent";
      } // Operator repairs externally.
      const receipt = await s.app.repair(grant, decision, true);
      expect(receipt.duplicate).toBe(false);
      expect(await start(() => s.store.activations.read()).result).toBeDefined();
      s.reopen();
      await s.app.observe();
      expect((await s.app.repair(grant, decision, true)).duplicate).toBe(true);
      await expect(
        s.app.repair(grant, { ...decision, evidence: "conflicting" }, true),
      ).rejects.toThrow();
      const terminal = await s.app.reconcile();
      expect(terminal).toMatchObject({
        state: "driven",
        result: { state: "cancelled", reason: "signup cancelled" },
      });
      const settled = await s.app.observe();
      expect(settled.root.state.status).toBe("cancelled");
      expect(settled.leaf.state.status).toBe("cancelled");
      expect(settled.leaf.entries[1]).toEqual(failedRelease);
      expect(settled.leaf.entries.at(-1)?.outcome).toEqual({ ok: true, value: decision });
      expect(resource).toBe(action === "waive" ? "reserved" : "absent");
      expect(s.peer.requests.map((request) => request.id)).toEqual(["reserve", "release"]);
    },
  );
  it.each(["none", "before-delivery", "unknown", "accepted", "cancel-after-accepted"] as const)(
    `${runtime.name}: protected signup commit preserves business state across cancellation/owner loss (%s)`,
    async (loss) => {
      const s = scenario(
        loss === "accepted" || loss === "cancel-after-accepted" ? "commit" : undefined,
      );
      await s.begin();
      await s.app.answer(waiting((await s.app.observe()).leaf), "approved");
      if (loss === "before-delivery") {
        s.pauseCommit = true;
        await expect(s.app.run().result).rejects.toThrow("Paused before commit delivery");
        expect(s.peer.requests).toHaveLength(1);
        await s.app.cancel();
        s.pauseCommit = false;
      }
      const committing = s.app.run();
      await Promise.race([s.peer.waitForRequests(2), committing.result]);
      const externalAccount = "active"; // Service committed; reply acceptance is separate.
      if (loss === "unknown") {
        await s.app.cancel();
        s.peer.fail("commit", new Error("Commit acknowledgement lost"));
        await expect(committing.result).rejects.toThrow("acknowledgement lost");
        s.reopen();
        const view = await s.app.observe();
        expect(view.leaf.state).toMatchObject({
          status: "running",
          cancellation: { reason: "signup cancelled" },
          pending: {
            request: { kind: "commit" },
            scope: { phase: "body", critical: expect.any(String) },
          },
        });
        expect(await s.app.reconcile()).toMatchObject({
          state: "driven",
          acknowledged: false,
          result: { state: "child", reason: "occupied" },
        });
        expect((await s.app.observe()).root.state.status).toBe("running");
      } else {
        s.peer.reply("commit", { status: 200, body: "committed" });
        if (loss === "accepted" || loss === "cancel-after-accepted") {
          await expect(committing.result).rejects.toThrow("Owner lost after acceptance");
          s.reopen();
          if (loss === "cancel-after-accepted") {
            await s.app.cancel();
          }
          expect(await s.app.run().result).toMatchObject(
            loss === "cancel-after-accepted"
              ? { state: "cancelled", reason: "signup cancelled" }
              : { state: "completed", value: "active" },
          );
        } else {
          expect(await committing.result).toMatchObject(
            loss === "before-delivery"
              ? { state: "cancelled", reason: "signup cancelled" }
              : { state: "completed", value: "active" },
          );
        }
      }
      expect(externalAccount).toBe("active");
      expect(s.peer.requests.map((request) => request.id)).toEqual(["reserve", "commit"]);
    },
  );
  it(`${runtime.name}: repair of the newest acquisition preserves earlier compensation in LIFO order`, async () => {
    const s = scenario(undefined, 2);
    await s.begin();
    await s.app.cancel();
    const cleanup = s.app.run();
    await Promise.race([s.peer.waitForRequests(3), cleanup.result]);
    expect(JSON.parse(s.peer.requests[2]!.token)).toEqual({
      kind: "release",
      resource: "workspace-2",
    });
    s.peer.reply("release", { status: 200, body: "denied" });
    expect(await cleanup.result).toMatchObject({ state: "child", reason: "waiting" });
    s.reopen();
    const view = await s.app.observe();
    expect(view.leaf.state).toMatchObject({
      pending: { request: { kind: "repair", resource: "workspace-2" } },
    });
    const repair = waiting(view.leaf);
    await expect(s.app.answer(repair, "approved")).rejects.toThrow("Not an approval");
    await s.app.repair(
      repair,
      { action: "confirmed-released", evidence: "workspace-repair-1" },
      true,
    );
    const remaining = s.app.run();
    await Promise.race([s.peer.waitForRequests(4), remaining.result]);
    expect(JSON.parse(s.peer.requests[3]!.token)).toEqual({ kind: "release", resource: "draft-1" });
    s.peer.reply("release", { status: 200, body: "released" });
    expect(await remaining.result).toMatchObject({
      state: "cancelled",
      reason: "signup cancelled",
    });
    expect(s.peer.requests.map((request) => request.id)).toEqual([
      "reserve",
      "reserve",
      "release",
      "release",
    ]);
  });
  it(`${runtime.name}: unknown compensation delivery remains occupied, not a known repair failure`, async () => {
    const s = scenario();
    await s.begin();
    await s.app.cancel();
    const cleanup = s.app.run();
    await Promise.race([s.peer.waitForRequests(2), cleanup.result]);
    s.peer.fail("release", new Error("Release outcome unknown"));
    await expect(cleanup.result).rejects.toThrow("Release outcome unknown");
    s.reopen();
    const before = await s.app.observe();
    expect(before.leaf.state).toMatchObject({
      status: "running",
      cancellation: { reason: "signup cancelled" },
      pending: { request: { kind: "release" }, scope: { phase: "cleanup" } },
    });
    expect(before.leaf.entries.map((entry) => entry.request.kind)).toEqual(["reserve"]);
    expect(await s.app.reconcile()).toMatchObject({
      state: "driven",
      acknowledged: false,
      result: { state: "child", reason: "occupied" },
    });
    expect((await s.app.observe()).root.state.status).toBe("running");
    expect(s.peer.requests.map((request) => request.id)).toEqual(["reserve", "release"]);
  });
  it(`${runtime.name}: accepted acquisition survives owner loss before compensation registration`, async () => {
    const s = scenario("reserve");
    await expect(s.begin()).rejects.toThrow("Owner lost after acceptance");
    s.reopen();
    await s.app.cancel();
    const cleanup = s.app.run();
    await Promise.race([s.peer.waitForRequests(2), cleanup.result]);
    expect(s.peer.requests.map((request) => request.id)).toEqual(["reserve", "release"]);
    s.peer.reply("release", { status: 200, body: "released" });
    expect(await cleanup.result).toMatchObject({ state: "cancelled", reason: "signup cancelled" });
  });
});
