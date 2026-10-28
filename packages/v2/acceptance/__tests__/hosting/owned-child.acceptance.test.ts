import { isDeepStrictEqual } from "node:util";
import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import { createRecovery, type ChildLink, type ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest, type LogicalScope } from "@sweatpan.ts/execution";
import { createHosting, type HostedResult } from "@sweatpan.ts/hosting";
import { createMemoryJournal, type MemoryOwnedChild } from "@sweatpan.ts/storage-memory";
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
    const parent = createMemoryJournal<string[], string, string, string>({
      program: "parent",
      equals: isDeepStrictEqual,
    });
    const peer = createProtocolRig();
    const children = new Map<
      string,
      MemoryOwnedChild<{ approval: string }, string, string, string>
    >();
    const waits = new Map<string, { grant: ResolutionGrant; request: string }>();
    const links: ChildLink[] = [];
    let rejectProjection = false;
    let beforeChild: Work<void, Y> | undefined;
    const projection = (value: { approval: string }): Outcome<string, string> => {
      if (rejectProjection) {
        throw new Error("Projection rejected");
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
                outcome: projection,
              },
            );
            if (!children.has(child.link.childId)) {
              children.set(child.link.childId, child);
              links.push(child.link);
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
      parent,
      peer,
      links,
      children,
      waits,
      run,
      begin,
      answer,
      finish,
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
      expect(snapshot.child).toBeUndefined();
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
        expect(blocked.cancellationRequested?.reason).toBe("deadline");
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
        expect(snapshot.cancellationRequested).toBeUndefined();
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

    it("leaves both journals unchanged when terminal projection fails, then retries settlement through recovery", async () => {
      const s = scenario();
      await s.begin();
      const link = s.links[0]!;
      const child = s.children.get(link.childId)!;
      await s.answer(link.childId);
      await s.run().result;
      await s.answer(link.childId, "closed");
      const parentBefore = await start(() => s.parent.read()).result;
      const childBefore = await start(() => child.journal.read()).result;
      s.rejectProjection = true;
      await expect(s.run().result).rejects.toThrow("Projection rejected");
      expect(await start(() => s.parent.read()).result).toEqual(parentBefore);
      expect(await start(() => child.journal.read()).result).toEqual(childBefore);
      s.rejectProjection = false;
      expect(await s.finish()).toEqual({ state: "completed", value: ["approved"] });
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
