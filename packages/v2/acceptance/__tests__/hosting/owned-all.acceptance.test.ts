import {
  createHostedRecovery as createRecovery,
  createSqliteJournalRig,
  readJournal,
} from "@sweatpan.ts/testing";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Work } from "@standard-durability/core";
import { type OwnedChild, type ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting } from "@sweatpan.ts/hosting";

import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

interface Request {
  readonly operation: string;
  readonly programs?: readonly string[];
}
function* ask<T>(operation: string): Operation<T, Request> {
  return (yield { operation }) as T;
}
// Authoring tracer only: journal ownership is production; no public ctx.all protocol yet.
function* all(programs: readonly string[]): Operation<readonly string[], Request> {
  if (!programs.length) {
    return [];
  }
  return (yield { operation: "all", programs }) as readonly string[];
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution;
  }
  function scenario(critical = false, nested = false) {
    const store = createSqliteJournalRig<readonly string[], Request, unknown, string, unknown, Y>({
      program: "research-parent",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    type Child = OwnedChild<string, Request, unknown, string, unknown, Y>;
    let journal = store.open();
    let children: readonly Child[] = [];
    let acquired: readonly string[] = [];
    let boundary = "";
    let projectionFails = false;
    let deferChildren = false;
    let raceCancellation = false;
    const descendants = new Map<string, Child>();
    const visits = new Map<string, number>();
    const waits = new Map<string, ResolutionGrant>();
    const operations = new Map<string, string>();
    let parentWait: ResolutionGrant | undefined;
    function* runChild(child: Child): Operation<boolean, Y> {
      const label = child.link.input as string;
      const recovery = createRecovery(runtime, {
        name: `all-child-recovery:${label}`,
        program: child.link.program,
        matches: isDeepStrictEqual,
        *acquire() {
          visits.set(label, (visits.get(label) ?? 0) + 1);
          return createScopedGuest(function* (scope) {
            yield* scope.ensure(function* () {
              yield* ask<string>("child-cleanup");
            });
            if (nested && (label === "security" || label === "performance")) {
              const work = () => all([`${label}/a`, `${label}/b`]);
              const values = label === "performance" ? yield* scope.critical(work) : yield* work();
              return values.join(",");
            }
            return yield* ask<string>("research");
          });
        },
      });
      const host = createHosting(runtime.composition, {
        name: `all-child-host:${label}`,
        journal: child.journal,
        recovery: recovery.operations,
        attempts: child.journal.attempts,
        interactions: child.journal.interactions,
        *handle() {
          throw new Error("Children use participant delivery");
        },
      });
      yield* host.around({
        *deliveryMode() {
          if (raceCancellation && label === "performance") {
            raceCancellation = false;
            // Activation has observed this sibling's old boundary. Commit the other
            // child's cancellation now, before this host registers that boundary.
            expect(yield* runChild(children[0]!)).toBe(true);
          }
          return "wait";
        },
        *child([pending], next) {
          if (pending.request.operation !== "all") {
            return yield* next(pending);
          }
          const group = yield* child.journal.ensureChildren<string, Request, unknown, string>(
            pending.id,
            {
              children: pending.request.programs!.map((input) => ({
                program: "research-child",
                input,
              })),
              outcome: (values) => ({ ok: true, value: values }),
            },
          );
          for (const descendant of group) {
            descendants.set(descendant.link.input as string, descendant);
          }
          return {
            id: pending.id,
            *run() {
              const settled = yield* runtime.all(group.map((entry) => () => runChild(entry)));
              return settled.every(Boolean);
            },
          };
        },
      });
      const result = yield* host.operations.run();
      if (result.state === "waiting") {
        waits.set(label, result.grant);
        operations.set(label, result.pending.request.operation);
      } else {
        waits.delete(label);
        operations.delete(label);
      }
      return result.state === "completed" || result.state === "cancelled";
    }
    function run() {
      return start(function* () {
        const recovery = createRecovery(runtime, {
          name: "all-parent-recovery",
          program: "research-parent",
          matches: isDeepStrictEqual,
          *acquire() {
            return createScopedGuest(function* (scope) {
              yield* scope.ensure(function* () {
                yield* ask<string>("parent-cleanup");
              });
              return critical
                ? yield* scope.critical(() => all(["security", "performance"]))
                : yield* all(["security", "performance"]);
            });
          },
        });
        const host = createHosting(runtime.composition, {
          name: "all-parent-host",
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          *handle() {
            throw new Error("Parent uses owned calls and participant cleanup");
          },
        });
        yield* host.around({
          *deliveryMode() {
            return "wait";
          },
          *child([pending], next) {
            if (pending.request.operation !== "all") {
              return yield* next(pending);
            }
            boundary = pending.id;
            children = yield* journal.ensureChildren<string, Request, unknown, string>(pending.id, {
              children: pending.request.programs!.map((input) => ({
                program: "research-child",
                input,
              })),
              outcome(values) {
                expectTypeOf(values).toEqualTypeOf<readonly string[]>();
                if (projectionFails) {
                  throw new Error("Join projection failed");
                }
                return { ok: true, value: values };
              },
            });
            acquired = children.map((child) => child.link.childId);
            return {
              id: pending.id,
              *run() {
                if (deferChildren) {
                  return false;
                }
                if (raceCancellation) {
                  return yield* runChild(children[1]!);
                }
                const settled = yield* runtime.all(children.map((child) => () => runChild(child)));
                return settled.every(Boolean);
              },
            };
          },
        });
        const result = yield* host.operations.run();
        if (result.state === "waiting") {
          parentWait = result.grant;
        }
        return result;
      }).result;
    }
    return {
      store,
      run,
      visits,
      waits,
      operations,
      descendants,
      raceCancellation() {
        raceCancellation = true;
      },
      get ids() {
        return acquired;
      },
      get boundary() {
        return boundary;
      },
      get children() {
        return children;
      },
      get journal() {
        return journal;
      },
      deferChildren(value: boolean) {
        deferChildren = value;
      },
      failProjection(value: boolean) {
        projectionFails = value;
      },
      reopen() {
        journal = store.reopen();
        children = [];
        descendants.clear();
        waits.clear();
        operations.clear();
      },
      reply(label: string, value = label, fail = false) {
        const child =
          descendants.get(label) ?? children.find((child) => child.link.input === label)!;
        const grant = waits.get(label)!;
        return start(() =>
          child.journal.interactions.answer(
            grant,
            fail ? { ok: false, error: value } : { ok: true, value },
          ),
        ).result;
      },
      cancel() {
        return start(() => journal.cancellation.request(boundary, "stop all")).result;
      },
      cancelChild(label: string) {
        const child =
          descendants.get(label) ?? children.find((child) => child.link.input === label)!;
        return start(() =>
          child.journal.cancellation.request(waits.get(label)!.requestId, "child stopped"),
        ).result;
      },
      releaseParent() {
        return start(() =>
          journal.interactions.answer(parentWait!, { ok: true, value: "released" }),
        ).result;
      },
      snapshot() {
        return start(() => readJournal(journal)).result;
      },
    };
  }

  for (const failures of [false, true]) {
    it(`${runtime.name}: owned all cancellation fences siblings and joins every cleanup before parent unwind (failures: ${failures})`, async () => {
      const s = scenario();
      await s.run();
      const stale = s.children.map((child) => ({
        child,
        grant: s.waits.get(child.link.input as string)!,
      }));
      await s.cancel();
      for (const { child, grant } of stale) {
        await expect(
          start(() => child.journal.interactions.answer(grant, { ok: true, value: "late" })).result,
        ).rejects.toThrow("revoked");
      }
      await s.run();
      expect([...s.operations.values()]).toEqual(["child-cleanup", "child-cleanup"]);
      await s.reply("performance", failures ? "performance cleanup failed" : "closed", failures);
      expect((await s.run()).state).toBe("child");
      s.reopen();
      await s.run();
      expect(s.operations.get("security")).toBe("child-cleanup");
      expect(s.waits.has("performance")).toBe(false);
      await s.reply("security", failures ? "security cleanup failed" : "closed", failures);
      const unwound = await s.run();
      if (unwound.state !== "waiting") {
        throw new Error("Expected parent cleanup after children drain");
      }
      expect(unwound.pending.request.operation).toBe("parent-cleanup");
      await s.releaseParent();
      const result = await s.run();
      expect(result.state).toBe("cancelled");
      if (result.state !== "cancelled") {
        throw new Error("Expected cancellation");
      }
      expect(result.reason).toBe("stop all");
      if (failures) {
        expect(result.failure).toBe("security cleanup failed\nperformance cleanup failed");
      } else {
        expect(result.failure).toBeUndefined();
      }
    });
  }

  it(`${runtime.name}: independently cancelled child fences remaining siblings before the group can settle`, async () => {
    const s = scenario();
    await s.run();
    await s.cancelChild("security");
    await s.run();
    expect(s.operations.get("security")).toBe("child-cleanup");
    const sibling = s.children[1]!;
    const grant = s.waits.get("performance")!;
    await s.reply("security", "closed");
    s.raceCancellation();
    expect((await s.run()).state).toBe("child");
    await expect(
      start(() => sibling.journal.interactions.answer(grant, { ok: true, value: "late" })).result,
    ).rejects.toThrow("revoked");
    expect(s.operations.get("performance")).toBe("child-cleanup");
    await s.reply("performance", "closed");
    expect((await s.run()).state).toBe("waiting");
    await s.releaseParent();
    await expect(s.run()).resolves.toMatchObject({ state: "cancelled", reason: "child stopped" });
  });

  it(`${runtime.name}: owned all cancellation before children start queues every stop`, async () => {
    const s = scenario();
    s.deferChildren(true);
    await s.run();
    expect(s.visits.size).toBe(0);
    await s.cancel();
    s.reopen();
    s.deferChildren(false);
    await s.run();
    expect([...s.operations.values()]).toEqual(["child-cleanup", "child-cleanup"]);
    await s.reply("security", "closed");
    await s.reply("performance", "closed");
    expect((await s.run()).state).toBe("waiting");
    await s.releaseParent();
    await expect(s.run()).resolves.toMatchObject({ state: "cancelled", reason: "stop all" });
  });

  it(`${runtime.name}: critical owned all preserves sibling authority until the join is safe`, async () => {
    const s = scenario(true);
    await s.run();
    await s.cancel();
    await s.reply("performance", "performance-result");
    await s.reply("security", "security-result");
    await s.run();
    expect([...s.operations.values()]).toEqual(["child-cleanup", "child-cleanup"]);
    await s.reply("performance", "closed");
    await s.reply("security", "closed");
    const result = await s.run();
    expect(result.state).toBe("waiting");
    expect((await s.snapshot()).history[0]?.outcome).toEqual({
      ok: true,
      value: ["security-result", "performance-result"],
    });
    await s.releaseParent();
    await expect(s.run()).resolves.toMatchObject({ state: "cancelled", reason: "stop all" });
  });

  it(`${runtime.name}: nested branching cancellation fences eligible leaves and drains protected joins across reopen`, async () => {
    const s = scenario(false, true);
    await s.run();
    expect([...s.descendants.keys()].sort()).toEqual([
      "performance/a",
      "performance/b",
      "security/a",
      "security/b",
    ]);
    const grants = new Map(s.waits);
    await s.cancel();
    for (const label of ["security/a", "security/b"]) {
      const child = s.descendants.get(label)!;
      await expect(
        start(() =>
          child.journal.interactions.answer(grants.get(label)!, { ok: true, value: "late" }),
        ).result,
      ).rejects.toThrow("revoked");
    }
    // The other branch owns a critical group: its leaves retain authority.
    for (const label of ["performance/a", "performance/b"]) {
      const child = s.descendants.get(label)!;
      const snapshot = await start(() => child.journal.read()).result;
      expect(snapshot.cancellation).toBeUndefined();
    }
    s.reopen();
    await s.run();
    expect(s.operations.get("security/a")).toBe("child-cleanup");
    expect(s.operations.get("security/b")).toBe("child-cleanup");
    expect(s.operations.get("performance/a")).toBe("research");
    expect(s.operations.get("performance/b")).toBe("research");
    expect(s.operations.has("security")).toBe(false);
    for (const label of ["performance/a", "performance/b"]) {
      const child = s.descendants.get(label)!;
      await start(() =>
        child.journal.interactions.answer(grants.get(label)!, { ok: true, value: label }),
      ).result;
    }
    await s.reply("security/a", "closed");
    await s.run();
    expect(s.operations.has("security")).toBe(false);
    await s.reply("security/b", "closed");
    await s.run();
    expect(s.operations.get("security")).toBe("child-cleanup");
    expect(s.operations.has("performance")).toBe(false);
    await s.reply("security", "closed");
    await s.reply("performance/a", "closed");
    expect((await s.run()).state).toBe("child");
    s.reopen();
    await s.run();
    expect(s.operations.get("performance/b")).toBe("child-cleanup");
    expect(s.operations.has("performance")).toBe(false);
    await s.reply("performance/b", "closed");
    await s.run();
    expect(s.operations.get("performance")).toBe("child-cleanup");
    const branch = await start(() => readJournal(s.children[1]!.journal)).result;
    expect(branch.history[0]?.outcome).toEqual({
      ok: true,
      value: ["performance/a", "performance/b"],
    });
    await s.reply("performance", "closed");
    const parent = await s.run();
    expect(parent.state).toBe("waiting");
    if (parent.state !== "waiting") {
      throw new Error("Expected parent cleanup");
    }
    expect(parent.pending.request.operation).toBe("parent-cleanup");
    await s.releaseParent();
    await expect(s.run()).resolves.toMatchObject({ state: "cancelled", reason: "stop all" });
  });

  it(`${runtime.name}: failed group projection rolls back the last child completion and parent acceptance`, async () => {
    const s = scenario();
    await s.run();
    await s.reply("security", "security-result");
    await s.run();
    await s.reply("security", "closed");
    await s.run();
    await s.reply("performance", "performance-result");
    await s.run();
    await s.reply("performance", "closed");
    s.reopen(); // New trusted binding is installed in this assembly.
    s.failProjection(true);
    await expect(s.run()).rejects.toThrow("Join projection failed");
    expect((await s.snapshot()).history).toHaveLength(0);
    expect((await start(() => s.children[1]!.journal.read()).result).status).toBe("running");
    s.reopen();
    s.failProjection(false);
    expect((await s.run()).state).toBe("waiting");
    expect((await s.snapshot()).history).toHaveLength(1);
    await s.releaseParent();
    await expect(s.run()).resolves.toEqual({
      state: "completed",
      value: ["security-result", "performance-result"],
    });
  });
});
