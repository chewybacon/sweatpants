import { childHostingResult } from "@sweatpan.ts/hosting";
import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import { createActivationReconciler } from "@sweatpan.ts/deployment";
import { createActivationIntents, type OwnedJournal } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting, type HostedResult } from "@sweatpan.ts/hosting";
import { createMemoryJournalStore } from "@sweatpan.ts/storage-memory";
import {
  createHostedRecovery,
  createSqliteJournalRig,
  createProtocolRig,
} from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task.result;
  }
  for (const storage of ["memory", "sqlite"] as const) {
    function createStore() {
      const options = { program: "reconcile", equals: isDeepStrictEqual };
      if (storage === "sqlite") {
        const rig = createSqliteJournalRig<string, string, string, string, unknown, Y>(options);
        onTestFinished(() => rig.close());
        return rig;
      }
      const store = createMemoryJournalStore<string, string, string, string>(options);
      return { ...store, reopen: () => store.open(), connect: () => store.open() };
    }

    it(`${runtime.name}/${storage}: accepted answer survives missing scheduling and stale acknowledgements`, async () => {
      const store = createStore();
      let journal = store.open();
      let deliveries = 0;
      let runs = 0;
      let acknowledgements = 0;
      let shouldYield = false;
      function assemble() {
        const intents = createActivationIntents(runtime.composition, "intents", store.activations);
        const reconciler = createActivationReconciler(runtime.composition, "reconciler", {
          intents,
          *run(): Operation<HostedResult<string, string>, Y> {
            runs++;
            const recovery = createHostedRecovery(runtime, {
              name: "reconcile-recovery",
              program: "reconcile",
              matches: isDeepStrictEqual,
              *acquire() {
                return createScopedGuest(function* () {
                  const response: unknown = yield "provider";
                  const answer: unknown = yield "question";
                  return `${String(response)}:${String(answer)}`;
                });
              },
            });
            const host = createHosting(runtime.composition, {
              name: "reconcile-host",
              journal,
              recovery: recovery.operations,
              attempts: journal.attempts,
              interactions: journal.interactions,
              *handle(): Operation<Outcome<string, string>, Y> {
                deliveries++;
                return { ok: true, value: "accepted" };
              },
            });
            yield* host.around({
              *continuation() {
                return shouldYield ? { action: "yield", reason: "budget" } : { action: "continue" };
              },
              *deliveryMode([request]) {
                return request === "question" ? "wait" : "execute";
              },
            });
            return yield* host.operations.run();
          },
        });
        expect(reconciler.intents).toBe(intents);
        return reconciler;
      }
      let app = assemble();
      expect(await start(app.operations.reconcile)).toEqual({ state: "idle" });
      expect(runs).toBe(0);
      await start(() => journal.admit("reconcile", { input: "pinned" }));
      const admitted = (await start(app.intents.operations.read))!;
      shouldYield = true;
      expect(await start(app.operations.reconcile)).toEqual({
        state: "driven",
        result: { state: "yielded", reason: "budget" },
        acknowledged: false,
      });
      expect(await start(app.intents.operations.read)).toEqual(admitted);
      shouldYield = false;
      const waiting = await start(app.operations.reconcile);
      expect(waiting.state).toBe("driven");
      if (waiting.state !== "driven" || waiting.result.state !== "waiting") {
        throw new Error("Expected participant wait");
      }
      expect(waiting.acknowledged).toBe(false); // Writes during this pass superseded admission.
      expect(deliveries).toBe(1);
      const observed = (await start(app.intents.operations.read))!;
      const stable = await start(function* () {
        yield* app.intents.around({
          *acknowledge(args, next) {
            acknowledgements++;
            return yield* next(...args);
          },
        });
        return yield* app.operations.reconcile();
      });
      expect(stable.state === "driven" && stable.acknowledged).toBe(true);
      expect(acknowledgements).toBe(1);
      expect(await start(app.operations.reconcile)).toEqual({ state: "idle" });

      // A duplicate wakeup races answer ingress on a separate SQLite connection.
      // The answer commits after the Host observes its wait, before acknowledgement.
      await start(app.intents.operations.request);
      const ingress = store.connect();
      const grant = waiting.result.grant;
      const raced = await start(function* () {
        yield* app.intents.around({
          *acknowledge(args, next) {
            yield* ingress.interactions.answer(grant, { ok: true, value: "yes" });
            return yield* next(...args);
          },
        });
        return yield* app.operations.reconcile();
      });
      expect(raced.state === "driven" && raced.acknowledged).toBe(false);
      // No scheduling callback follows the answer; reopen from persisted intent.
      journal = store.reopen();
      app = assemble();
      const pending = (await start(app.intents.operations.read))!;
      expect(pending.execution).toBe(store.id);
      expect(pending.token).not.toBe(observed.token);
      expect(await start(() => app.intents.operations.acknowledge(observed))).toBe(false);
      expect(await start(app.intents.operations.read)).toEqual(pending);
      const completed = await start(app.operations.reconcile);
      expect(completed).toEqual({
        state: "driven",
        result: { state: "completed", value: "accepted:yes" },
        acknowledged: false,
      });
      expect(await start(app.operations.reconcile)).toEqual({
        state: "driven",
        result: { state: "completed", value: "accepted:yes" },
        acknowledged: true,
      });
      expect(await start(app.operations.reconcile)).toEqual({ state: "idle" });
      expect(deliveries).toBe(1);
      await expect(
        start(() => app.intents.operations.acknowledge({ ...pending, execution: "foreign" })),
      ).rejects.toThrow("Foreign activation intent");
    });

    for (const nested of [false, true]) {
      for (const succeeds of [false, true]) {
        it(`${runtime.name}/${storage}: overlapping pass preserves ${nested ? "child" : "root"} in-flight intent (${succeeds ? "settles" : "fails"})`, async () => {
          const store = createStore();
          type Journal = OwnedJournal<string, string, string, string, unknown, Y>;
          const peer = createProtocolRig();
          function* drive(
            journal: Journal,
            program: string,
            parent: boolean,
          ): Operation<HostedResult<string, string>, Y> {
            const recovery = createHostedRecovery(runtime, {
              name: `overlap:${journal.id}`,
              program,
              matches: isDeepStrictEqual,
              *acquire() {
                return createScopedGuest(function* () {
                  return String(yield parent ? "child" : "provider");
                });
              },
            });
            const host = createHosting(runtime.composition, {
              name: `overlap-host:${journal.id}`,
              journal,
              recovery: recovery.operations,
              attempts: journal.attempts,
              *handle(): Operation<Outcome<string, string>, Y> {
                const reply = yield* runtime.fromPromise((signal) =>
                  peer.send({ id: "provider", token: "delivery" }, signal),
                );
                return { ok: true, value: reply.body };
              },
            });
            yield* host.around({
              *child([pending], next) {
                if (pending.request !== "child") {
                  return yield* next(pending);
                }
                const child = yield* journal.ensureChild<string, string, string, string>(
                  pending.id,
                  {
                    program: "leaf",
                    input: null,
                    outcome: (value) => ({ ok: true, value }),
                  },
                );
                return {
                  id: child.link.childId,
                  *run() {
                    const result = yield* drive(child.journal, child.link.program, false);
                    return childHostingResult(result);
                  },
                };
              },
            });
            return yield* host.operations.run();
          }
          function assemble(journal: Journal) {
            return createActivationReconciler(runtime.composition, "overlap", {
              intents: createActivationIntents(
                runtime.composition,
                "activation-intents",
                store.activations,
              ),
              run: () => drive(journal, "reconcile", nested),
            });
          }
          const first = assemble(store.open());
          await start(first.intents.operations.request);
          const active = runtime.start(first.operations.reconcile);
          void active.result.catch(() => undefined);
          onTestFinished(() => active.cancel());
          await Promise.race([peer.waitForRequests(1), active.result]);
          const token = await start(first.intents.operations.read);
          const observer = assemble(store.connect());
          const observed = await start(observer.operations.reconcile);
          expect(observed.state === "driven" && observed.result.state).toBe(
            nested ? "child" : "occupied",
          );
          expect(await start(observer.intents.operations.read)).toEqual(token);
          if (succeeds) {
            peer.reply("provider", { status: 200, body: "accepted" });
            await active.result;
          } else {
            peer.fail("provider", new Error("Delivery uncertain"));
            await expect(active.result).rejects.toThrow("Delivery uncertain");
          }
          const recovered = assemble(store.reopen());
          expect(await start(recovered.intents.operations.read)).toBeDefined();
          const result = await start(recovered.operations.reconcile);
          expect(result.state === "driven" && result.result.state).toBe(
            succeeds ? "completed" : nested ? "child" : "occupied",
          );
          if (succeeds) {
            expect(await start(recovered.operations.reconcile)).toEqual({ state: "idle" });
          } else {
            expect(await start(recovered.intents.operations.read)).toEqual(token);
          }
          expect(peer.requests).toHaveLength(1);
        });
      }
    }

    for (const failure of ["delivery", "acknowledgement"] as const) {
      it(`${runtime.name}/${storage}: ${failure} failure leaves reconcilable intent without redelivery`, async () => {
        const store = createStore();
        let journal = store.open();
        let deliveries = 0;
        let fail = true;
        function assemble() {
          return createActivationReconciler(runtime.composition, "failure-reconciler", {
            intents: createActivationIntents(
              runtime.composition,
              "activation-intents",
              store.activations,
            ),
            *run() {
              const recovery = createHostedRecovery(runtime, {
                name: "failure-recovery",
                program: "reconcile",
                matches: isDeepStrictEqual,
                *acquire() {
                  return createScopedGuest(function* () {
                    return String(yield "provider");
                  });
                },
              });
              const host = createHosting(runtime.composition, {
                name: "failure-host",
                journal,
                recovery: recovery.operations,
                attempts: journal.attempts,
                *handle(): Operation<Outcome<string, string>, Y> {
                  deliveries++;
                  if (failure === "delivery") {
                    throw new Error("Delivery uncertain");
                  }
                  return { ok: true, value: "accepted" };
                },
              });
              yield* host.attempts.around({
                *settle(args, next) {
                  const result = yield* next(...args);
                  if (fail) {
                    throw new Error("Acknowledgement lost");
                  }
                  return result;
                },
              });
              return yield* host.operations.run();
            },
          });
        }
        let app = assemble();
        await start(app.intents.operations.request);
        await expect(start(app.operations.reconcile)).rejects.toThrow(
          failure === "delivery" ? "Delivery uncertain" : "Acknowledgement lost",
        );
        journal = store.reopen();
        app = assemble();
        fail = false;
        expect(await start(app.intents.operations.read)).toBeDefined();
        const resumed = await start(app.operations.reconcile);
        expect(resumed.state === "driven" && resumed.result.state).toBe(
          failure === "delivery" ? "occupied" : "completed",
        );
        await start(app.operations.reconcile);
        if (failure === "delivery") {
          expect(await start(app.intents.operations.read)).toBeDefined();
        } else {
          expect(await start(app.operations.reconcile)).toEqual({ state: "idle" });
        }
        expect(deliveries).toBe(1);
      });
    }

    it(`${runtime.name}/${storage}: child answers wake the root and failed parent projection rolls back intent`, async () => {
      const store = createStore();
      let root = store.open();
      type Journal = OwnedJournal<string, string, string, string, unknown, Y>;
      let child: Journal | undefined;
      let grant: import("@sweatpan.ts/durable").ResolutionGrant | undefined;
      let failProjection = false;
      let yieldChild = false;
      function* drive(
        journal: Journal,
        program: string,
        leaf: boolean,
      ): Operation<HostedResult<string, string>, Y> {
        const recovery = createHostedRecovery(runtime, {
          name: `tree-recovery:${journal.id}`,
          program,
          matches: isDeepStrictEqual,
          *acquire() {
            return createScopedGuest(function* () {
              return String(yield leaf ? "question" : "child");
            });
          },
        });
        const host = createHosting(runtime.composition, {
          name: `tree-host:${journal.id}`,
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          *handle() {
            throw new Error("Tree uses participant delivery");
          },
        });
        yield* host.around({
          *continuation() {
            return leaf && yieldChild
              ? { action: "yield", reason: "child budget" }
              : { action: "continue" };
          },
          *deliveryMode() {
            return "wait";
          },
          *child([pending], next) {
            if (pending.request !== "child") {
              return yield* next(pending);
            }
            const owned = yield* journal.ensureChild<string, string, string, string>(pending.id, {
              program: "leaf",
              input: null,
              outcome(value) {
                if (failProjection) {
                  throw new Error("Projection failed");
                }
                return { ok: true, value };
              },
            });
            child = owned.journal;
            return {
              id: owned.link.childId,
              *run() {
                const result = yield* drive(owned.journal, owned.link.program, true);
                if (result.state === "waiting") {
                  grant = result.grant;
                }
                return childHostingResult(result);
              },
            };
          },
        });
        return yield* host.operations.run();
      }
      function assemble() {
        return createActivationReconciler(runtime.composition, "tree", {
          intents: createActivationIntents(
            runtime.composition,
            "activation-intents",
            store.activations,
          ),
          run: () => drive(root, "reconcile", false),
        });
      }
      let app = assemble();
      await start(app.intents.operations.request);
      const waiting = await start(app.operations.reconcile);
      expect(waiting.state === "driven" && waiting.result.state).toBe("child");
      const stable = await start(app.operations.reconcile);
      expect(stable.state === "driven" && stable.acknowledged).toBe(true);
      expect(await start(app.intents.operations.read)).toBeUndefined();
      const requested = await start(app.intents.operations.request);
      yieldChild = true;
      expect(await start(app.operations.reconcile)).toEqual({
        state: "driven",
        result: { state: "yielded", reason: "child budget" },
        acknowledged: false,
      });
      expect(await start(app.intents.operations.read)).toEqual(requested);
      root = store.reopen();
      app = assemble();
      yieldChild = false;
      await start(app.operations.reconcile);
      expect(await start(app.intents.operations.read)).toBeUndefined();
      await start(() => child!.interactions.answer(grant!, { ok: true, value: "leaf answer" }));
      const answered = (await start(app.intents.operations.read))!;
      expect(answered.execution).toBe(store.id);
      failProjection = true;
      await expect(start(app.operations.reconcile)).rejects.toThrow("Projection failed");
      expect(await start(app.intents.operations.read)).toEqual(answered);
      root = store.reopen();
      app = assemble();
      failProjection = false;
      const result = await start(app.operations.reconcile);
      expect(result).toEqual({
        state: "driven",
        result: { state: "completed", value: "leaf answer" },
        acknowledged: false,
      });
      await start(app.operations.reconcile);
      expect(await start(app.operations.reconcile)).toEqual({ state: "idle" });
    });

    for (const window of ["before", "after"] as const) {
      it(`${runtime.name}/${storage}: ${window}-delete intent acknowledgement failure requires rereading`, async () => {
        const store = createStore();
        const journal = store.open();
        let deliveries = 0;
        const app = createActivationReconciler(runtime.composition, "intent-ack-failure", {
          intents: createActivationIntents(
            runtime.composition,
            "activation-intents",
            store.activations,
          ),
          *run() {
            const recovery = createHostedRecovery(runtime, {
              name: "ack-recovery",
              program: "reconcile",
              matches: isDeepStrictEqual,
              *acquire() {
                return createScopedGuest(function* () {
                  return String(yield "provider");
                });
              },
            });
            const host = createHosting(runtime.composition, {
              name: "ack-host",
              journal,
              recovery: recovery.operations,
              attempts: journal.attempts,
              *handle(): Operation<Outcome<string, string>, Y> {
                deliveries++;
                return { ok: true, value: "accepted" };
              },
            });
            return yield* host.operations.run();
          },
        });
        await start(app.intents.operations.request);
        await start(app.operations.reconcile);
        const token = await start(app.intents.operations.read);
        await expect(
          start(function* () {
            yield* app.intents.around({
              *acknowledge(args, next) {
                if (window === "after") {
                  expect(yield* next(...args)).toBe(true);
                }
                throw new Error("Intent acknowledgement failed");
              },
            });
            return yield* app.operations.reconcile();
          }),
        ).rejects.toThrow("Intent acknowledgement failed");
        expect(await start(app.intents.operations.read)).toEqual(
          window === "before" ? token : undefined,
        );
        const resumed = await start(app.operations.reconcile);
        expect(resumed.state).toBe(window === "before" ? "driven" : "idle");
        expect(await start(app.operations.reconcile)).toEqual({ state: "idle" });
        expect(deliveries).toBe(1);
      });
    }

    it(`${runtime.name}/${storage}: cancellation wakes a quiescent nested tree and drains cleanup after reopen`, async () => {
      const store = createStore();
      let root = store.open();
      type Journal = OwnedJournal<string, string, string, string, unknown, Y>;
      const cleaned: string[] = [];
      function* drive(
        journal: Journal,
        program: string,
        parent: boolean,
      ): Operation<HostedResult<string, string>, Y> {
        const recovery = createHostedRecovery(runtime, {
          name: `cancel-recovery:${journal.id}`,
          program,
          matches: isDeepStrictEqual,
          *acquire() {
            return createScopedGuest(function* (scope) {
              yield* scope.ensure(function* () {
                yield "cleanup";
              });
              return String(yield parent ? "child" : "question");
            });
          },
        });
        const host = createHosting(runtime.composition, {
          name: `cancel-host:${journal.id}`,
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          *handle(request): Operation<Outcome<string, string>, Y> {
            expect(request).toBe("cleanup");
            cleaned.push(program);
            return { ok: true, value: "released" };
          },
        });
        yield* host.around({
          *deliveryMode([request]) {
            return request === "cleanup" ? "execute" : "wait";
          },
          *child([pending], next) {
            if (pending.request !== "child") {
              return yield* next(pending);
            }
            const child = yield* journal.ensureChild<string, string, string, string>(pending.id, {
              program: "leaf",
              input: null,
              outcome: (value) => ({ ok: true, value }),
            });
            return {
              id: child.link.childId,
              *run() {
                return childHostingResult(yield* drive(child.journal, child.link.program, false));
              },
            };
          },
        });
        return yield* host.operations.run();
      }
      function assemble() {
        return createActivationReconciler(runtime.composition, "cancel-tree", {
          intents: createActivationIntents(
            runtime.composition,
            "activation-intents",
            store.activations,
          ),
          run: () => drive(root, "reconcile", true),
        });
      }
      let app = assemble();
      await start(app.intents.operations.request);
      await start(app.operations.reconcile);
      await start(app.operations.reconcile);
      expect(await start(app.intents.operations.read)).toBeUndefined();
      const snapshot = await start(() => root.read());
      if (snapshot.status !== "running" || !snapshot.pending) {
        throw new Error("Missing child boundary");
      }
      await start(() => root.cancellation.request(snapshot.pending!.id, "stop"));
      root = store.reopen();
      app = assemble();
      expect(await start(app.intents.operations.read)).toBeDefined();
      const result = await start(app.operations.reconcile);
      expect(result.state === "driven" && result.result.state).toBe("cancelled");
      expect(cleaned).toEqual(["leaf", "reconcile"]);
      await start(app.operations.reconcile);
      expect(await start(app.operations.reconcile)).toEqual({ state: "idle" });
      expect(cleaned).toHaveLength(2);
    });

    it(`${runtime.name}/${storage}: rolled-back journal writes leave intent unchanged`, async () => {
      const store = createStore();
      const journal = store.open();
      await start(() => journal.read());
      expect(await start(store.activations.read)).toBeUndefined();
      const first = await start(store.activations.request);
      await expect(
        start(() => journal.admit("reconcile", () => "unencodable")),
      ).rejects.toBeDefined();
      expect(await start(store.activations.read)).toEqual(first);
      const second = await start(store.activations.request);
      expect(second.token).not.toBe(first.token);
      expect(await start(() => store.activations.acknowledge(first))).toBe(false);
      expect(await start(() => store.activations.acknowledge(second))).toBe(true);
      expect(await start(() => store.activations.acknowledge(second))).toBe(false);
      expect(await start(store.activations.read)).toBeUndefined();
    });
  }
});
