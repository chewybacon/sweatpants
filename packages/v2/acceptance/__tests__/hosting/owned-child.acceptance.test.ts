import { isDeepStrictEqual } from "node:util";
import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import { createRecovery, type ChildLink, type ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest, type LogicalScope } from "@sweatpan.ts/execution";
import { createHosting, type HostedResult } from "@sweatpan.ts/hosting";
import {
  createMemoryJournal,
  createMemoryJournalStore,
  type MemoryOwnedChild,
  type MemoryJournal,
} from "@sweatpan.ts/storage-memory";
import { createProtocolRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

function* ask(request: string): Operation<string, string> {
  const reply: unknown = yield request;
  if (typeof reply !== "string") {
    throw new Error("Expected text reply");
  }
  return reply;
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution;
  }
  function scenario(
    options: {
      count?: number;
      liveApproval?: boolean;
      call?: "body" | "cleanup" | "critical";
      liveCleanup?: boolean;
    } = {},
  ) {
    const { count = 1, liveApproval = false, call = "body", liveCleanup = false } = options;
    const store = createMemoryJournalStore<string[], string, string, string>({
      program: "parent",
      equals: isDeepStrictEqual,
    });
    let parent = store.open();
    let assembly = 0;
    const projectedAssemblies: number[] = [];
    const peer = createProtocolRig();
    const children = new Map<
      string,
      MemoryOwnedChild<{ approval: string }, string, string, string>
    >();
    const waits = new Map<string, { grant: ResolutionGrant; request: string }>();
    const links: ChildLink[] = [];
    let rejectProjection = false;
    let unencodableProjection = false;
    let beforeChild: Work<void, Y> | undefined;
    const projection = (value: { approval: string }): Outcome<string, string> => {
      if (rejectProjection) {
        throw new Error("Projection rejected");
      }
      if (unencodableProjection) {
        const outcome = { ok: true as const, value: value.approval, attachment: () => undefined };
        return outcome;
      }
      return { ok: true, value: value.approval };
    };
    function* childWork(scope: LogicalScope) {
      yield* scope.ensure(function* () {
        yield* ask("child-close");
      });
      return { approval: yield* ask("approval") };
    }
    function* runChild(child: MemoryOwnedChild<{ approval: string }, string, string, string>) {
      const recovery = createRecovery(runtime.composition, {
        name: "child-recovery",
        program: "child",
        matches: isDeepStrictEqual,
        *acquire() {
          return createScopedGuest(childWork);
        },
      });
      const host = createHosting(runtime.composition, {
        name: "child-host",
        recovery: recovery.operations,
        journal: child.journal,
        attempts: child.journal.attempts,
        interactions: child.journal.interactions,
        *handle(request: string): Operation<Outcome<string, string>, Y> {
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: request, token: "child" }, signal),
          );
          return { ok: true, value: reply.body };
        },
      });
      yield* host.around({
        *deliveryMode([request]) {
          return (liveApproval && request === "approval") ||
            (liveCleanup && request === "child-close")
            ? "execute"
            : "wait";
        },
      });
      const result = yield* host.operations.run();
      expectTypeOf(result).toEqualTypeOf<HostedResult<{ approval: string }, string>>();
      if (result.state === "waiting") {
        waits.set(child.link.childId, { grant: result.grant, request: result.pending.request });
      }
      return result.state === "completed" || result.state === "cancelled";
    }
    function run() {
      const generation = assembly;
      return start(function* () {
        const recovery = createRecovery(runtime.composition, {
          name: "parent-recovery",
          program: "parent",
          matches: isDeepStrictEqual,
          *acquire() {
            return createScopedGuest(function* (scope) {
              yield* ask("reserve");
              yield* scope.ensure(function* () {
                yield* ask("release");
              });
              if (call === "cleanup") {
                yield* scope.ensure(function* () {
                  yield* ask("call:cleanup");
                });
                return [] as string[];
              }
              const values: string[] = [];
              for (let index = 0; index < count; index++) {
                values.push(
                  call === "critical"
                    ? yield* scope.critical(function* () {
                        return yield* ask(`call:${index}`);
                      })
                    : yield* ask(`call:${index}`),
                );
              }
              return values;
            });
          },
        });
        const host = createHosting(runtime.composition, {
          name: "parent-host",
          recovery: recovery.operations,
          journal: parent,
          attempts: parent.attempts,
          *handle(request: string): Operation<Outcome<string, string>, Y> {
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send({ id: request, token: "parent" }, signal),
            );
            return { ok: true, value: reply.body };
          },
        });
        yield* host.around({
          *child([pending], next) {
            if (!pending.request.startsWith("call:")) {
              return yield* next(pending);
            }
            const child = yield* parent.ensureChild<{ approval: string }, string, string, string>(
              pending.id,
              {
                program: "child",
                input: pending.request,
                outcome(value) {
                  projectedAssemblies.push(generation);
                  return projection(value);
                },
              },
            );
            if (!children.has(child.link.childId)) {
              children.set(child.link.childId, child);
              if (!links.some((link) => link.childId === child.link.childId)) {
                links.push(child.link);
              }
            }
            if (beforeChild) {
              yield* beforeChild();
            }
            return { id: child.link.childId, run: () => runChild(child) };
          },
        });
        return yield* host.operations.run();
      });
    }
    async function begin() {
      const execution = run();
      await Promise.race([peer.waitForRequests(1), execution.result]);
      peer.reply("reserve", { status: 200, body: "reserved" });
      return execution.result;
    }
    function answer(childId: string, value = "approved") {
      return start(() =>
        children
          .get(childId)!
          .journal.interactions.answer(waits.get(childId)!.grant, { ok: true, value }),
      ).result;
    }
    async function finish() {
      const execution = run();
      await Promise.race([peer.waitForRequests(liveApproval ? 3 : 2), execution.result]);
      expect(peer.requests.map((request) => request.id)).toEqual(
        liveApproval ? ["reserve", "approval", "release"] : ["reserve", "release"],
      );
      peer.reply("release", { status: 200, body: "released" });
      return execution.result;
    }
    return {
      get parent() {
        return parent;
      },
      projectedAssemblies,
      reopen() {
        parent = store.open();
        assembly++;
        children.clear();
        waits.clear();
      },
      peer,
      links,
      children,
      waits,
      run,
      begin,
      answer,
      finish,
      set unencodableProjection(value: boolean) {
        unencodableProjection = value;
      },
      set rejectProjection(value: boolean) {
        rejectProjection = value;
      },
      set beforeChild(value: Work<void, Y> | undefined) {
        beforeChild = value;
      },
    };
  }

  describe(`${runtime.name}: sequential owned calls`, () => {
    it("reacquires the same child after disposal, settles once, and assigns a new child to the next call", async () => {
      const s = scenario({ count: 2 });
      expect((await s.begin()).state).toBe("child");
      const first = s.links[0]!;
      expect(await s.run().result).toEqual({ state: "child", childId: first.childId });
      expect(s.links).toHaveLength(1);
      await s.answer(first.childId);
      expect((await s.run().result).state).toBe("child");
      expect(s.waits.get(first.childId)!.request).toBe("child-close");
      const receipt = await s.answer(first.childId, "closed");
      expect((await s.answer(first.childId, "closed")).duplicate).toBe(true);
      expect((await s.run().result).state).toBe("child");
      const second = s.links[1]!;
      expect(second.childId).not.toBe(first.childId);
      expect(second.requestId).not.toBe(first.requestId);
      expect(second.parentId).toBe(first.parentId);
      expect(receipt.entry.request).toBe("child-close");
      await s.answer(second.childId, "approved again");
      await s.run().result;
      await s.answer(second.childId, "closed");
      expect(await s.finish()).toEqual({
        state: "completed",
        value: ["approved", "approved again"],
      });
      const snapshot = await start(() => s.parent.read()).result;
      expect(snapshot.history.map((entry) => entry.request)).toEqual([
        "reserve",
        "call:0",
        "call:1",
        "release",
      ]);
      expect(snapshot).not.toHaveProperty("child");
      expect(await s.run().result).toEqual({
        state: "completed",
        value: ["approved", "approved again"],
      });
      expect(s.peer.requests).toHaveLength(2);
    });

    for (const failCleanup of [false, true]) {
      it(`holds parent cancellation behind recoverable child cleanup (cleanup failure: ${failCleanup})`, async () => {
        const s = scenario();
        await s.begin();
        const link = s.links[0]!;
        const approval = s.waits.get(link.childId)!.grant;
        const cancel = () =>
          start(() => s.parent.cancellation.request(link.requestId, "deadline")).result;
        await cancel();
        const blocked = await start(() => s.parent.read()).result;
        expect(blocked).toMatchObject({
          status: "running",
          cancellationRequested: { reason: "deadline" },
        });
        expect(blocked.cancellation).toBeUndefined();
        expect((await s.run().result).state).toBe("child");
        expect(s.waits.get(link.childId)!.request).toBe("child-close");
        const close = s.waits.get(link.childId)!.grant;
        await cancel();
        await expect(
          start(() =>
            s.children
              .get(link.childId)!
              .journal.interactions.answer(approval, { ok: true, value: "late" }),
          ).result,
        ).rejects.toThrow("revoked");
        expect((await s.run().result).state).toBe("child");
        expect(s.waits.get(link.childId)!.grant).toEqual(close);
        expect(s.peer.requests.map((request) => request.id)).toEqual(["reserve"]);
        await start(() =>
          s.children
            .get(link.childId)!
            .journal.interactions.answer(
              close,
              failCleanup
                ? { ok: false, error: "Child release failed" }
                : { ok: true, value: "closed" },
            ),
        ).result;
        const expected = {
          state: "cancelled",
          reason: "deadline",
          failure: failCleanup ? "Child release failed" : undefined,
        };
        expect(await s.finish()).toEqual(expected);
        expect(await s.run().result).toEqual(expected);
        const snapshot = await start(() => s.parent.read()).result;
        expect(snapshot.history.map((entry) => entry.request)).toEqual(["reserve", "release"]);
        expect(snapshot).not.toHaveProperty("cancellationRequested");
      });
    }

    it("preserves a normal child cleanup request when parent cancellation arrives after the body returned", async () => {
      const s = scenario();
      await s.begin();
      const link = s.links[0]!;
      await s.answer(link.childId);
      await s.run().result;
      const cleanup = s.waits.get(link.childId)!;
      expect(cleanup.request).toBe("child-close");
      const before = await start(() => s.children.get(link.childId)!.journal.read()).result;
      expect(before.status === "running" && before.pending?.scope?.phase).toBe("cleanup");
      await start(() => s.parent.cancellation.request(link.requestId, "deadline")).result;
      await s.run().result;
      expect(s.waits.get(link.childId)!.grant).toEqual(cleanup.grant);
      expect(s.peer.requests.map((request) => request.id)).toEqual(["reserve"]);
      await s.answer(link.childId, "closed");
      expect(await s.finish()).toEqual({ state: "cancelled", reason: "deadline" });
      const after = await start(() => s.children.get(link.childId)!.journal.read()).result;
      expect(after.history.map((entry) => entry.request)).toEqual(["approval", "child-close"]);
    });

    it("joins a child owned by cleanup without cancelling that child's body", async () => {
      const s = scenario({ call: "cleanup" });
      await s.begin();
      const link = s.links[0]!;
      const approval = s.waits.get(link.childId)!.grant;
      await start(() => s.parent.cancellation.request(link.requestId, "deadline")).result;
      await s.run().result;
      expect(s.waits.get(link.childId)!.grant).toEqual(approval);
      expect(
        (await start(() => s.children.get(link.childId)!.journal.read()).result).cancellation,
      ).toBeUndefined();
      await s.answer(link.childId);
      await s.run().result;
      await s.answer(link.childId, "closed");
      expect(await s.finish()).toEqual({ state: "cancelled", reason: "deadline" });
    });

    it("accepts the existing live cleanup attempt after parent cancellation changes the result", async () => {
      const s = scenario({ liveCleanup: true });
      await s.begin();
      const link = s.links[0]!;
      await s.answer(link.childId);
      const live = s.run();
      await Promise.race([s.peer.waitForRequests(2), live.result]);
      expect(s.peer.requests[1]!.id).toBe("child-close");
      await start(() => s.parent.cancellation.request(link.requestId, "deadline")).result;
      const snapshot = await start(() => s.children.get(link.childId)!.journal.read()).result;
      expect(snapshot.cancellation?.attempt).toBeUndefined();
      s.peer.reply("child-close", { status: 200, body: "closed" });
      await Promise.race([s.peer.waitForRequests(3), live.result]);
      expect(s.peer.requests[2]!.id).toBe("release");
      s.peer.reply("release", { status: 200, body: "released" });
      expect(await live.result).toEqual({ state: "cancelled", reason: "deadline" });
    });

    it("joins a child called inside critical without cancelling its body", async () => {
      const s = scenario({ call: "critical" });
      await s.begin();
      const link = s.links[0]!;
      const approval = s.waits.get(link.childId)!.grant;
      const before = await start(() => s.parent.read()).result;
      expect(before.status === "running" && before.pending?.scope?.critical).toBeTruthy();
      await start(() => s.parent.cancellation.request(link.requestId, "deadline")).result;
      await s.run().result;
      expect(s.waits.get(link.childId)!.grant).toEqual(approval);
      expect(
        (await start(() => s.children.get(link.childId)!.journal.read()).result).cancellation,
      ).toBeUndefined();
      await s.answer(link.childId);
      await s.run().result;
      await s.answer(link.childId, "closed");
      expect(await s.finish()).toEqual({ state: "cancelled", reason: "deadline" });
      const after = await start(() => s.parent.read()).result;
      expect(after.history.map((entry) => entry.request)).toEqual(["reserve", "call:0", "release"]);
    });

    it("reopens participant authority and historical ownership with freshly bound projections", async () => {
      const s = scenario();
      await s.begin();
      const link = s.links[0]!;
      const approval = s.waits.get(link.childId)!.grant;
      const previous = s.children.get(link.childId)!.journal;
      s.reopen();
      await s.run().result;
      expect(s.links).toEqual([link]);
      expect(s.children.get(link.childId)!.journal).not.toBe(previous);
      expect(s.waits.get(link.childId)!.grant).toEqual(approval);
      await s.answer(link.childId);
      await s.run().result;
      await s.answer(link.childId, "closed");
      s.reopen();
      expect(await s.finish()).toEqual({ state: "completed", value: ["approved"] });
      expect(s.projectedAssemblies).toEqual([2]);
      s.reopen();
      const historical = await start(() =>
        s.parent.ensureChild<{ approval: string }, string, string, string>(link.requestId, {
          program: link.program,
          input: link.input,
          outcome: (value) => ({ ok: true, value: value.approval }),
        }),
      ).result;
      expect(historical.link).toEqual(link);
      expect((await start(() => historical.journal.read()).result).status).toBe("completed");
      expect(
        (
          await start(() =>
            historical.journal.interactions.answer(approval, { ok: true, value: "approved" }),
          ).result
        ).duplicate,
      ).toBe(true);
      expect(await s.run().result).toEqual({ state: "completed", value: ["approved"] });
    });

    it("reopens queued cancellation before the child's first boundary without delivering its body", async () => {
      const s = scenario();
      s.beforeChild = function* () {
        yield* s.parent.cancellation.request(s.links[0]!.requestId, "deadline");
        throw new Error("Host stopped before child acquisition");
      };
      await expect(s.begin()).rejects.toThrow("Host stopped");
      const link = s.links[0]!;
      s.beforeChild = undefined;
      s.reopen();
      await s.run().result;
      expect(s.waits.get(link.childId)!.request).toBe("child-close");
      await s.answer(link.childId, "closed");
      s.reopen();
      expect(await s.finish()).toEqual({ state: "cancelled", reason: "deadline" });
      expect(s.projectedAssemblies).toEqual([]);
    });

    it("queues cancellation before a child has its first boundary and never delivers its body request", async () => {
      const s = scenario();
      s.beforeChild = function* () {
        const link = s.links[0]!;
        yield* s.parent.cancellation.request(link.requestId, "stop before child starts");
      };
      await s.begin();
      const child = s.links[0]!;
      expect(s.waits.get(child.childId)!.request).toBe("child-close");
      await s.answer(child.childId, "closed");
      expect(await s.finish()).toEqual({ state: "cancelled", reason: "stop before child starts" });
    });

    for (const failure of ["throw", "encode"]) {
      it(`leaves both journals unchanged when terminal projection fails (${failure}), then retries settlement through recovery`, async () => {
        const s = scenario();
        await s.begin();
        const link = s.links[0]!;
        const child = s.children.get(link.childId)!;
        await s.answer(link.childId);
        await s.run().result;
        await s.answer(link.childId, "closed");
        const parentBefore = await start(() => s.parent.read()).result;
        const childBefore = await start(() => child.journal.read()).result;
        s.rejectProjection = failure === "throw";
        s.unencodableProjection = failure === "encode";
        await expect(s.run().result).rejects.toBeDefined();
        expect(await start(() => s.parent.read()).result).toEqual(parentBefore);
        expect(await start(() => child.journal.read()).result).toEqual(childBefore);
        s.rejectProjection = false;
        s.unencodableProjection = false;
        expect(await s.finish()).toEqual({ state: "completed", value: ["approved"] });
      });
    }

    it("fences a three-level owned tree before returning and drains cleanup from leaf to root", async () => {
      const root = createMemoryJournal<string, string, string, string>({
        program: "level:0",
        equals: isDeepStrictEqual,
      });
      const journals = new Map<number, MemoryJournal<string, string, string, string>>([[0, root]]);
      const waits = new Map<number, { request: string; grant: ResolutionGrant }>();
      function* runLevel(
        depth: number,
        journal: MemoryJournal<string, string, string, string>,
      ): Operation<HostedResult<string, string>, Y> {
        const recovery = createRecovery(runtime.composition, {
          name: `recovery:${depth}`,
          program: `level:${depth}`,
          matches: isDeepStrictEqual,
          *acquire() {
            return createScopedGuest(function* (scope) {
              yield* scope.ensure(function* () {
                yield* ask(`close:${depth}`);
              });
              return yield* ask(depth < 2 ? "call" : "approval");
            });
          },
        });
        const host = createHosting(runtime.composition, {
          name: `host:${depth}`,
          recovery: recovery.operations,
          journal,
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
          *child([pending], next) {
            if (pending.request !== "call") {
              return yield* next(pending);
            }
            const child = yield* journal.ensureChild<string, string, string, string>(pending.id, {
              program: `level:${depth + 1}`,
              input: depth + 1,
              outcome: (value) => ({ ok: true, value }),
            });
            journals.set(depth + 1, child.journal);
            return {
              id: child.link.childId,
              *run() {
                const result = yield* runLevel(depth + 1, child.journal);
                return result.state === "completed" || result.state === "cancelled";
              },
            };
          },
        });
        const result = yield* host.operations.run();
        if (result.state === "waiting") {
          waits.set(depth, { request: result.pending.request, grant: result.grant });
        }
        return result;
      }
      const run = () => start(() => runLevel(0, root)).result;
      await run();
      const leaf = journals.get(2)!;
      const late = waits.get(2)!;
      const before = await start(() => root.read()).result;
      if (before.status !== "running" || !before.pending) {
        throw new Error("Expected owned call");
      }
      await start(() => root.cancellation.request(before.pending!.id, "deadline")).result;
      // No host advancement or abort notification is required to fence the leaf.
      await expect(
        start(() => leaf.interactions.answer(late.grant, { ok: true, value: "late" })).result,
      ).rejects.toThrow("revoked");
      for (const depth of [2, 1, 0]) {
        await run();
        const waiting = waits.get(depth)!;
        expect(waiting.request).toBe(`close:${depth}`);
        await start(() =>
          journals.get(depth)!.interactions.answer(waiting.grant, { ok: true, value: "closed" }),
        ).result;
      }
      expect(await run()).toEqual({ state: "cancelled", reason: "deadline" });
      for (const journal of journals.values()) {
        expect((await start(() => journal.read()).result).status).toBe("cancelled");
      }
      // A retained older handle observes the same terminal record as reacquired handles.
      expect((await start(() => leaf.read()).result).status).toBe("cancelled");
    });

    it("fences a live child's late settlement when parent cancellation has no abort notification", async () => {
      const s = scenario({ liveApproval: true });
      const live = s.run();
      await Promise.race([s.peer.waitForRequests(1), live.result]);
      s.peer.reply("reserve", { status: 200, body: "reserved" });
      await Promise.race([s.peer.waitForRequests(2), live.result]);
      const link = s.links[0]!;
      await start(() => s.parent.cancellation.request(link.requestId, "deadline")).result;
      expect((await s.run().result).state).toBe("child");
      expect(s.waits.get(link.childId)!.request).toBe("child-close");
      s.peer.reply("approval", { status: 200, body: "late" });
      await expect(live.result).rejects.toThrow("revoked");
      await s.answer(link.childId, "closed");
      expect(await s.finish()).toEqual({ state: "cancelled", reason: "deadline" });
    });

    it("rejects alternate delivery species and a changed program/input for the owned call", async () => {
      const s = scenario();
      await s.begin();
      const link = s.links[0]!;
      await expect(
        start(() => s.parent.attempts.begin(link.requestId, "unsafe")).result,
      ).rejects.toThrow("Owned call");
      await expect(
        start(() => s.parent.accept(link.requestId, { ok: true, value: "bypass" })).result,
      ).rejects.toThrow("Owned call");
      await expect(
        start(() => s.parent.interactions.register(link.requestId)).result,
      ).rejects.toThrow("Owned call");
      await expect(
        start(() =>
          s.parent.ensureChild(link.requestId, {
            program: "changed",
            input: link.input,
            outcome: () => ({ ok: true, value: "wrong" }),
          }),
        ).result,
      ).rejects.toThrow("differs");
    });
  });
});
