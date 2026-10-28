import { isDeepStrictEqual } from "node:util";
import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import { createRecovery, type Journal, type ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest, type LogicalScope } from "@sweatpan.ts/execution";
import { createHosting, type HostedResult } from "@sweatpan.ts/hosting";
import { createMemoryJournal } from "@sweatpan.ts/storage-memory";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

function* ask(request: string): Operation<string, string> {
  const value: unknown = yield request;
  if (typeof value !== "string") {
    throw new Error("Expected text response");
  }
  return value;
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution;
  }
  function scenario() {
    const journal = createMemoryJournal<{ answer: string }, string, string, string>({
      program: "scopes",
      equals: isDeepStrictEqual,
    });
    let bodyTail = 0;
    function* work(scope: LogicalScope) {
      yield* scope.ensure(function* () {
        yield* ask("audit");
      });
      yield* scope.ensure(function* () {
        yield* scope.scoped(function* (cleanupScope) {
          yield* cleanupScope.ensure(function* () {
            yield* ask("outer-close-ack");
          });
          yield* ask("outer-close");
        });
      });
      const result = yield* scope.scoped(function* (child) {
        yield* child.ensure(function* () {
          yield* ask("child-close");
        });
        return { answer: yield* ask("approval") };
      });
      expectTypeOf(result).toEqualTypeOf<{ answer: string }>();
      bodyTail++;
      return result;
    }
    function run(store: Journal<{ answer: string }, string, string, string, unknown, Y> = journal) {
      return start(function* () {
        const recovery = createRecovery(runtime.composition, {
          name: "scopes",
          program: "scopes",
          matches: isDeepStrictEqual,
          *acquire() {
            return createScopedGuest(work);
          },
        });
        const host = createHosting(runtime.composition, {
          name: "scope-host",
          recovery: recovery.operations,
          journal: store,
          attempts: journal.attempts,
          interactions: journal.interactions,
          *handle(): Operation<Outcome<string, string>, Y> {
            throw new Error("Participant replies only");
          },
        });
        yield* host.around({
          *deliveryMode() {
            return "wait";
          },
        });
        return yield* host.operations.run();
      }).result;
    }
    async function waiting(request: string) {
      const result = await run();
      expectTypeOf(result).toEqualTypeOf<HostedResult<{ answer: string }, string>>();
      if (result.state !== "waiting") {
        throw new Error(`Expected ${request}, got ${result.state}`);
      }
      expect(result.pending.request).toBe(request);
      return result;
    }
    const answer = (
      grant: ResolutionGrant,
      outcome: Outcome<string, string> = { ok: true, value: "yes" },
    ) => start(() => journal.interactions.answer(grant, outcome)).result;
    return {
      journal,
      run,
      waiting,
      answer,
      get bodyTail() {
        return bodyTail;
      },
    };
  }
  describe(`${runtime.name}: logical scope exit`, () => {
    for (const cancel of [false, true]) {
      it(`joins lexical child cleanup and nested cleanup scopes across host disposal (cancel: ${cancel})`, async () => {
        const s = scenario();
        const approval = await s.waiting("approval");
        expect(approval.pending.scope?.phase).toBe("body");
        await s.answer(approval.grant);
        const childClose = await s.waiting("child-close");
        expect(childClose.pending.scope?.phase).toBe("cleanup");
        expect(s.bodyTail).toBe(0);
        if (cancel) {
          await start(() => s.journal.cancellation.request(childClose.pending.id, "deadline"))
            .result;
        }
        const recovered = await s.waiting("child-close");
        expect(recovered.pending).toEqual(childClose.pending);
        expect(recovered.grant).toEqual(childClose.grant);
        await s.answer(childClose.grant);
        const outer = await s.waiting("outer-close");
        expect(outer.pending.scope?.phase).toBe("cleanup");
        if (cancel) {
          expect(s.bodyTail).toBe(0);
          await start(() => s.journal.cancellation.request(childClose.pending.id, "repeat")).result;
        }
        await s.answer(outer.grant);
        const ack = await s.waiting("outer-close-ack");
        await s.answer(ack.grant);
        const audit = await s.waiting("audit");
        await s.answer(audit.grant);
        expect(await s.run()).toEqual(
          cancel
            ? { state: "cancelled", reason: "deadline" }
            : { state: "completed", value: { answer: "yes" } },
        );
        const snapshot = await start(() => s.journal.read()).result;
        expect(snapshot.history.map((entry) => entry.request)).toEqual([
          "approval",
          "child-close",
          "outer-close",
          "outer-close-ack",
          "audit",
        ]);
      });
    }
    it("retains cleanup failures, attempts remaining frames and does not restart cleanup on repeat cancellation", async () => {
      const s = scenario();
      const approval = await s.waiting("approval");
      await start(() => s.journal.cancellation.request(approval.pending.id, "deadline")).result;
      const child = await s.waiting("child-close");
      await s.answer(child.grant, { ok: false, error: "child failed" });
      const outer = await s.waiting("outer-close");
      await s.answer(outer.grant, { ok: false, error: "outer failed" });
      const ack = await s.waiting("outer-close-ack");
      await start(() => s.journal.cancellation.request(approval.pending.id, "again")).result;
      await s.answer(ack.grant);
      const audit = await s.waiting("audit");
      await s.answer(audit.grant);
      expect(await s.run()).toEqual({
        state: "cancelled",
        reason: "deadline",
        failure: "child failed\nouter failed",
      });
    });
    it("drains remaining frames after normal-exit cleanup failure before reporting it", async () => {
      const s = scenario();
      const approval = await s.waiting("approval");
      await s.answer(approval.grant);
      const child = await s.waiting("child-close");
      await s.answer(child.grant, { ok: false, error: "child failed" });
      const outer = await s.waiting("outer-close");
      await s.answer(outer.grant);
      const ack = await s.waiting("outer-close-ack");
      await s.answer(ack.grant);
      const audit = await s.waiting("audit");
      await s.answer(audit.grant);
      await expect(s.run()).rejects.toBe("child failed");
      const snapshot = await start(() => s.journal.read()).result;
      expect(snapshot.history.map((entry) => entry.request)).toEqual([
        "approval",
        "child-close",
        "outer-close",
        "outer-close-ack",
        "audit",
      ]);
    });

    for (const changed of ["scope", "critical"] as const) {
      it(`rejects changed ${changed} evidence even when the domain request is identical`, async () => {
        const s = scenario();
        const approval = await s.waiting("approval");
        await s.answer(approval.grant);
        const snapshot = await start(() => s.journal.read()).result;
        const tampered = {
          ...s.journal,
          *read() {
            return {
              ...snapshot,
              history: snapshot.history.map((entry) => ({
                ...entry,
                scope:
                  changed === "scope"
                    ? { scopeId: "wrong", frameId: "wrong", phase: "body" as const }
                    : { ...entry.scope!, critical: "unrecorded-region" },
              })),
            };
          },
        };
        await expect(s.run(tampered)).rejects.toThrow("Replay request mismatch");
      });
    }
  });
});
