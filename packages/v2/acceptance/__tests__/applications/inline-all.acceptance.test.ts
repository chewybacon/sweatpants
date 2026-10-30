import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import { defineEffect, type All, type Branch, type CapabilityRequest } from "@sweatpan.ts/core";
import {
  createScopedGuest,
  type LogicalScope,
  type ScopeInstruction,
} from "@sweatpan.ts/execution";
import { createRecovery, type OwnedChild, type ResolutionGrant } from "@sweatpan.ts/durable";
import {
  createEffectCapabilities,
  createHosting,
  installGuestRetention,
  createOwnedAll,
} from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createSqliteJournalRig, readJournal } from "@sweatpan.ts/testing";
import { defineTool } from "@sweatpan.ts/tools";
import { forEachRuntime } from "../runtime/assembly.ts";

const groupId = "inline.all";
const seed = defineEffect({ key: "inline.seed", context: z.string(), response: z.string() });
const approval = defineEffect({
  key: "inline.approval",
  context: z.string(),
  response: z.boolean(),
});
const compute = defineEffect({ key: "inline.compute", context: z.string(), response: z.number() });
const cleanup = defineEffect({ key: "inline.cleanup", context: z.string(), response: z.boolean() });
interface BranchContext {
  readonly scope: LogicalScope;
  readonly elicit: typeof approval.call;
  readonly compute: typeof compute.call;
  readonly cleanup: typeof cleanup.call;
  readonly score: (topic: string) => Operation<Outcome<number, never>, CapabilityRequest>;
}
type Factory = Branch<BranchContext, CapabilityRequest | ScopeInstruction>;
type ParentResult = [Outcome<boolean, unknown>, number];

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution.result;
  }
  function scenario(named = false) {
    const store = createSqliteJournalRig<
      ParentResult,
      CapabilityRequest,
      unknown,
      string,
      unknown,
      Y
    >({ program: "inline-parent:v1", equals: isDeepStrictEqual });
    onTestFinished(() => store.close());
    let journal = store.open();
    type Child = OwnedChild<unknown, CapabilityRequest, unknown, string, unknown, Y>;
    let children: readonly Child[] = [];
    const waits = new Map<number, { grant: ResolutionGrant; effect: string }>();
    let parentWait: ResolutionGrant | undefined;
    let boundary = "";
    let authoring: All<BranchContext, CapabilityRequest | ScopeInstruction> | undefined;
    const counts = { seed: 0, compute: 0, parent: 0, branches: [0, 0] };
    const cleanupOrder: string[] = [];
    const scoreTool = defineTool("inline.score")
      .parameters(z.string())
      .capabilities({ compute })
      .execute(function* (topic, ctx) {
        const result = yield* ctx.capabilities.compute(topic);
        if (!result.ok) {
          throw new Error("Compute failed");
        }
        return result.value;
      });
    function run() {
      return start(function* () {
        const effects = createEffectCapabilities(runtime, "inline-tracer");
        yield* effects.install(seed, function* (topic) {
          counts.seed++;
          return { ok: true, value: `${topic}-${counts.seed}` };
        });
        yield* effects.install(compute, function* (topic) {
          counts.compute++;
          expect(topic).toBe("research-1");
          return { ok: true, value: 42 };
        });
        const ownedAll = createOwnedAll<BranchContext, CapabilityRequest | ScopeInstruction, Y>(
          runtime,
          groupId,
        );
        const parentGrant = effects.grant({ seed, group: ownedAll.effect, cleanup });
        const recovery = createRecovery(runtime.composition, {
          name: "inline-parent-recovery",
          program: "inline-parent:v1",
          matches: isDeepStrictEqual,
          *acquire() {
            counts.parent++;
            // Fresh per parent incarnation. Replay reconstructs factories at the same slot.
            const all = yield* ownedAll.acquire();
            authoring = all;
            return createScopedGuest(function* (scope) {
              yield* scope.ensure(function* () {
                yield* parentGrant.capabilities.cleanup("parent");
              });
              const saved = yield* parentGrant.capabilities.seed("research");
              if (!saved.ok) {
                throw new Error("Missing seed");
              }
              const topic = saved.value; // Immutable capture reconstructed from accepted history.
              const result = yield* all(
                function* (branch) {
                  yield* branch.scope.ensure(function* () {
                    yield* branch.cleanup("approval");
                  });
                  return yield* branch.elicit(`Approve ${topic}?`);
                },
                function* (branch) {
                  yield* branch.scope.ensure(function* () {
                    yield* branch.cleanup("compute");
                  });
                  const value = named ? yield* branch.score(topic) : yield* branch.compute(topic);
                  if (!value.ok) {
                    throw new Error("Compute failed");
                  }
                  return value.value;
                },
              );
              expectTypeOf(result).toEqualTypeOf<ParentResult>();
              return result;
            });
          },
        });
        function* runChild(child: Child, index: number, factory: Factory): Operation<boolean, Y> {
          const grant = effects.grant({ approval, compute, cleanup, scoreTool });
          const childRecovery = createRecovery(runtime.composition, {
            name: `inline-child:${index}`,
            program: child.link.program,
            matches: isDeepStrictEqual,
            *acquire() {
              counts.branches[index] = counts.branches[index]! + 1;
              return createScopedGuest((scope) =>
                factory({
                  scope,
                  elicit: grant.capabilities.approval,
                  compute: grant.capabilities.compute,
                  cleanup: grant.capabilities.cleanup,
                  score: grant.capabilities.scoreTool,
                }),
              );
            },
          });
          const host = createHosting(runtime.composition, {
            name: `inline-child-host:${index}`,
            journal: child.journal,
            recovery: childRecovery.operations,
            attempts: child.journal.attempts,
            interactions: child.journal.interactions,
            handle: grant.handle,
          });
          yield* host.around(grant.admission);
          yield* host.around({
            *child([pending], next) {
              if (pending.request.effect !== scoreTool.id) {
                return yield* next(pending);
              }
              const snapshot = yield* child.journal.read();
              const existing = snapshot.status === "running" ? snapshot.children?.[0] : undefined;
              let input: unknown = existing?.input;
              if (!existing) {
                const parsed = yield* runtime.fromPromise(async () =>
                  scoreTool.context["~standard"].validate(pending.request.input),
                );
                if (parsed.issues) {
                  throw new Error("Invalid score tool input");
                }
                input = parsed.value;
              }
              const owned = yield* child.journal.ensureChild<
                number,
                CapabilityRequest,
                unknown,
                string
              >(pending.id, {
                program: scoreTool.id,
                input,
                outcome: (value) => ({ ok: true, value: { ok: true, value } }),
              });
              return {
                id: pending.id,
                *run() {
                  const toolGrant = effects.grant(scoreTool.capabilities, { record: true });
                  const toolRecovery = createRecovery(runtime.composition, {
                    name: "inline-score-recovery",
                    program: scoreTool.id,
                    matches: isDeepStrictEqual,
                    *acquire() {
                      yield* toolGrant.install();
                      return createScopedGuest((scope) =>
                        scoreTool.body(owned.link.input as string, {
                          scope,
                          capabilities: toolGrant.capabilities,
                          record: toolGrant.record,
                          *await() {
                            throw new Error("Score tool does not await recorded work");
                          },
                          elicit() {
                            throw new Error("Score tool declares no elicits");
                          },
                        }),
                      );
                    },
                  });
                  const toolHost = createHosting(runtime.composition, {
                    name: "inline-score-host",
                    journal: owned.journal,
                    recovery: toolRecovery.operations,
                    attempts: owned.journal.attempts,
                    handle: toolGrant.handle,
                  });
                  yield* toolHost.around(toolGrant.admission);
                  yield* installGuestRetention(
                    runtime.composition,
                    toolHost,
                    toolRecovery,
                    owned.journal,
                  );
                  const result = yield* toolHost.operations.run();
                  return result.state === "completed" || result.state === "cancelled";
                },
              };
            },
            *deliveryMode([request], next) {
              return request.effect === approval.id || request.effect === cleanup.id
                ? "wait"
                : yield* next(request);
            },
          });
          const result = yield* host.operations.run();
          if (result.state === "waiting") {
            waits.set(index, { grant: result.grant, effect: result.pending.request.effect });
          } else {
            waits.delete(index);
          }
          return result.state === "completed" || result.state === "cancelled";
        }
        const host = createHosting(runtime.composition, {
          name: "inline-parent-host",
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          handle: parentGrant.handle,
        });
        yield* host.around(parentGrant.admission);
        yield* host.around({
          *deliveryMode([request], next) {
            return request.effect === cleanup.id ? "wait" : yield* next(request);
          },
        });
        yield* ownedAll.install({
          host,
          journal,
          recovery,
          *run(child, factory, index) {
            children = [...children];
            (children as Child[])[index] = child;
            boundary = child.link.requestId;
            return yield* runChild(child, index, factory);
          },
        });
        // The retained parent owns branch closures while child hosts run. All are
        // discarded on host exit; the next parent replay builds fresh bindings.
        yield* installGuestRetention(runtime.composition, host, recovery, journal);
        const result = yield* host.operations.run();
        if (result.state === "waiting") {
          parentWait = result.grant;
        }
        return result;
      });
    }
    return {
      counts,
      expiredAuthoring() {
        return start(function* () {
          const guest = createScopedGuest(function* () {
            return yield* authoring!();
          });
          yield* runtime.composition.ensure(() => guest.close());
          return yield* guest.start();
        });
      },
      waits,
      cleanupOrder,
      run,
      get children() {
        return children;
      },
      get journal() {
        return journal;
      },
      reopen() {
        journal = store.reopen();
        children = [];
        waits.clear();
        parentWait = undefined;
      },
      answer(index: number, value = true) {
        return start(function* () {
          const waiting = waits.get(index)!;
          const result = yield* children[index]!.journal.interactions.answer(waiting.grant, {
            ok: true,
            value: { ok: true, value },
          });
          if (waiting.effect === cleanup.id) {
            cleanupOrder.push(index === 0 ? "approval" : "compute");
          }
          return result;
        });
      },
      cancel() {
        return start(() => journal.cancellation.request(boundary, "stop inline"));
      },
      finish() {
        return start(function* () {
          const result = yield* journal.interactions.answer(parentWait!, {
            ok: true,
            value: { ok: true, value: true },
          });
          cleanupOrder.push("parent");
          return result;
        });
      },
      snapshot() {
        return start(() => readJournal(journal));
      },
    };
  }

  for (const named of [false, true]) {
    it(`${runtime.name}: inline all (named tool: ${named}) reconstructs closures from parent replay and retains completed branch results`, async () => {
      const s = scenario(named);
      expect((await s.run()).state).toBe("child");
      expect(s.waits.get(0)!.effect).toBe(approval.id);
      expect(s.waits.get(1)!.effect).toBe(cleanup.id);
      expect(s.counts.compute).toBe(1); // Computes while the other branch is eliciting.
      await expect(s.expiredAuthoring()).rejects.toThrow("Owned all authoring scope is closed");
      await s.answer(1);
      await s.run();
      const finishedVisits = s.counts.branches[1];
      const ids = s.children.map((child) => child.link.childId);
      s.reopen();
      await s.run();
      expect(s.children.map((child) => child.link.childId)).toEqual(ids);
      expect(s.counts.branches[1]).toBe(finishedVisits);
      const pending = await start(() => s.children[0]!.journal.read());
      if (pending.status !== "running") {
        throw new Error("Expected pending approval");
      }
      expect(pending.pending!.request.input).toBe("Approve research-1?");
      await s.answer(0);
      s.reopen();
      await s.run();
      expect(s.waits.get(0)!.effect).toBe(cleanup.id);
      await s.answer(0);
      expect((await s.run()).state).toBe("waiting");
      await s.finish();
      const expected = { state: "completed", value: [{ ok: true, value: true }, 42] };
      await expect(s.run()).resolves.toEqual(expected);
      expect(s.counts.seed).toBe(1);
      expect(s.counts.compute).toBe(1);
      expect(s.cleanupOrder).toEqual(["compute", "approval", "parent"]);
      const snapshot = await s.snapshot();
      expect(snapshot.history.map((entry) => entry.request.effect)).toEqual([
        seed.id,
        groupId,
        cleanup.id,
      ]);
      expect(snapshot.history[1]!.request.input).toEqual({ slot: 0, count: 2 });
      const visits = { parent: s.counts.parent, branches: [...s.counts.branches] };
      s.reopen();
      await expect(s.run()).resolves.toEqual(expected);
      expect({ parent: s.counts.parent, branches: s.counts.branches }).toEqual(visits);
    });

    it(`${runtime.name}: cancelling inline all (named tool: ${named}) fences elicitation and joins branch cleanup before parent cleanup across reopen`, async () => {
      const s = scenario(named);
      await s.run();
      const stale = s.waits.get(0)!.grant;
      const child = s.children[0]!;
      await s.cancel();
      await expect(
        start(() =>
          child.journal.interactions.answer(stale, { ok: true, value: { ok: true, value: true } }),
        ),
      ).rejects.toThrow("revoked");
      // The compute branch was already in cleanup; its authority remains valid.
      await s.answer(1);
      s.reopen();
      expect((await s.run()).state).toBe("child");
      expect(s.waits.get(0)!.effect).toBe(cleanup.id);
      expect(s.waits.has(1)).toBe(false);
      await s.answer(0);
      expect((await s.run()).state).toBe("waiting");
      await s.finish();
      await expect(s.run()).resolves.toMatchObject({ state: "cancelled", reason: "stop inline" });
      expect(s.cleanupOrder).toEqual(["compute", "approval", "parent"]);
      expect(s.counts.seed).toBe(1);
      expect(s.counts.compute).toBe(1);
      const snapshot = await s.snapshot();
      expect(snapshot.history.map((entry) => entry.request.effect)).toEqual([seed.id, cleanup.id]);
    });
  }
});
