import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Outcome } from "@standard-durability/core";
import { createRecovery } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting, type HostedResult } from "@sweatpan.ts/hosting";
import { createMemoryJournal } from "@sweatpan.ts/storage-memory";
import { createLatch, createProtocolRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: sibling hosts inherit middleware, isolate Guest drivers and dispose exact incarnations`, async () => {
    const owner = runtime.composition.createContext<string>("execution-owner");
    const peer = createProtocolRig();
    const closed: string[] = [];
    const calls: string[] = [];
    let facadeCloses = 0;
    function acquire(label: string) {
      const guest = createScopedGuest(function* () {
        const value: unknown = yield "read";
        if (typeof value !== "string") {
          throw new Error("Expected reply text");
        }
        return { owner: label, value };
      });
      return {
        ...guest,
        *close() {
          closed.push(label);
          yield* guest.close();
        },
      };
    }
    const recovery = createRecovery(runtime.composition, {
      name: "shared-recovery",
      program: "read",
      matches: isDeepStrictEqual,
      *acquire() {
        return acquire(yield* owner.expect());
      },
    });
    const captured = recovery.execution.operations;
    const execution = runtime.start(function* () {
      yield* owner.set("parent");
      yield* recovery.execution.around({
        *start(args, next) {
          calls.push(`start:${yield* owner.expect()}`);
          return yield* next(...args);
        },
        *resume([outcome], next) {
          expectTypeOf(outcome).toEqualTypeOf<Outcome<unknown, unknown>>();
          calls.push(`resume:${yield* owner.expect()}`);
          return yield* next(outcome);
        },
        *close(args, next) {
          facadeCloses++;
          return yield* next(...args);
        },
      });
      const results = yield* runtime.all(
        ["a", "b"].map(
          (label) =>
            function* () {
              yield* owner.set(label);
              if (label === "a") {
                yield* recovery.execution.around({
                  resume(args, next) {
                    // next resolves the driver where it executes, without redispatching
                    // this middleware. The enclosing incarnation still owns its disposal.
                    return runtime.composition.scoped(function* () {
                      yield* recovery.execution.install(acquire("override"));
                      yield* captured.start();
                      return yield* next(...args);
                    });
                  },
                });
              }
              const journal = createMemoryJournal<
                { owner: string; value: string },
                string,
                string,
                string
              >({
                program: "read",
                equals: isDeepStrictEqual,
              });
              const host = createHosting(runtime.composition, {
                name: `host-${label}`,
                recovery: recovery.operations,
                journal,
                attempts: journal.attempts,
                *handle() {
                  const reply = yield* runtime.fromPromise((signal) =>
                    peer.send({ id: label, token: label }, signal),
                  );
                  return { ok: true, value: reply.body } as const;
                },
              });
              return yield* host.operations.run();
            },
        ),
      );
      expect(yield* owner.expect()).toBe("parent");
      return results;
    });
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    await Promise.race([peer.waitForRequests(2), execution.result]);
    peer.reply("b", { status: 200, body: "B" });
    peer.reply("a", { status: 200, body: "A" });
    const results = await execution.result;
    expectTypeOf(results).toEqualTypeOf<
      readonly HostedResult<{ owner: string; value: string }, string>[]
    >();
    expect(results).toEqual([
      { state: "completed", value: { owner: "override", value: "A" } },
      { state: "completed", value: { owner: "b", value: "B" } },
    ]);
    expect(calls.filter((value) => value.startsWith("resume:")).sort()).toEqual([
      "resume:a",
      "resume:b",
    ]);
    expect(closed.sort()).toEqual(["a", "a", "b", "b", "override"]);
    expect(facadeCloses).toBe(0);
    // A facade carried into another execution does not retain a disposed driver.
    await expect(runtime.start(() => captured.start()).result).rejects.toThrow(
      "Execution driver is not installed",
    );
  });

  it(`${runtime.name}: cancelling a restricted sibling drains its cleanup without disposing shared provider access`, async () => {
    const peer = createProtocolRig();
    const approval = createLatch<void>();
    const cancelA = createLatch<void>();
    const aSettled = createLatch<void>();
    const credentials = runtime.composition.createContext<string>("shared-provider-credentials");
    const provider = runtime.composition.createApi("shared-provider", {
      *exchange(
        owner: "a" | "b" | "parent",
        action: "probe" | "read" | "release",
      ): Operation<Outcome<string, string>, Y> {
        const token = yield* credentials.expect();
        const reply = yield* runtime.fromPromise((signal) =>
          peer.send({ id: `${owner}:${action}`, token }, signal),
        );
        return { ok: true, value: reply.body };
      },
    });
    const access = runtime.composition.createContext<typeof provider.operations>("provider-access");
    function* ask(request: "read" | "approval" | "release"): Operation<string, string> {
      const answer: unknown = yield request;
      if (typeof answer !== "string") {
        throw new Error("Expected provider reply text");
      }
      return answer;
    }
    function* sibling(owner: "a" | "b") {
      if (owner === "a") {
        yield* credentials.set("restricted-a");
        yield* provider.around({
          *exchange([requestedOwner, action], next) {
            if (requestedOwner !== "a") {
              return { ok: false, error: "Sibling access denied" };
            }
            return yield* next(requestedOwner, action);
          },
        });
        const shared = yield* access.expect();
        expect(yield* shared.exchange("b", "probe")).toEqual({
          ok: false,
          error: "Sibling access denied",
        });
        const nested = yield* runtime.composition.scoped(function* () {
          yield* credentials.set("nested-a");
          yield* provider.around({
            *exchange(args, next) {
              const reply = yield* next(...args);
              return reply.ok ? { ok: true, value: reply.value.toUpperCase() } : reply;
            },
          });
          return yield* shared.exchange("a", "probe");
        });
        expectTypeOf(nested).toEqualTypeOf<Outcome<string, string>>();
        expect(nested).toEqual({ ok: true, value: "NESTED" });
        expect(yield* credentials.expect()).toBe("restricted-a");
      }
      const journal = createMemoryJournal<{ text: string }, string, string, string>({
        program: `shared-provider-${owner}`,
        equals: isDeepStrictEqual,
      });
      const recovery = createRecovery(runtime.composition, {
        name: `shared-recovery-${owner}`,
        program: `shared-provider-${owner}`,
        matches: isDeepStrictEqual,
        *acquire() {
          return createScopedGuest(function* (scope) {
            yield* scope.ensure(function* () {
              yield* ask("release");
            });
            const text = yield* ask("read");
            if (owner === "a") {
              yield* ask("approval");
            }
            return { text };
          });
        },
      });
      const host = createHosting(runtime.composition, {
        name: `shared-host-${owner}`,
        recovery: recovery.operations,
        journal,
        attempts: journal.attempts,
        interactions: journal.interactions,
        *handle(request: string) {
          if (request !== "read" && request !== "release") {
            throw new Error("Approval must park");
          }
          const shared = yield* access.expect();
          return yield* shared.exchange(owner, request);
        },
      });
      yield* host.around({
        *deliveryMode([request]) {
          return request === "approval" ? "wait" : "execute";
        },
      });
      const first = yield* host.operations.run();
      expectTypeOf(first).toEqualTypeOf<HostedResult<{ text: string }, string>>();
      if (owner === "b") {
        return first;
      }
      if (first.state !== "waiting") {
        throw new Error("Expected approval boundary");
      }
      // The nested uppercase layer has exited before the hosted provider request.
      expect((yield* journal.read()).history.map(({ outcome }) => outcome)).toEqual([
        { ok: true, value: "a" },
      ]);
      approval.resolve();
      yield* runtime.fromPromise(() => cancelA.promise);
      yield* host.operations.cancel(first.pending.id, "stop a");
      const result = yield* host.operations.run();
      expect(result).toEqual({ state: "cancelled", reason: "stop a" });
      aSettled.resolve();
      return result;
    }
    const execution = runtime.start(function* () {
      return yield* runtime.using(
        function* () {
          yield* runtime.fromPromise((signal) =>
            peer.send({ id: "provider:open", token: "owner" }, signal),
          );
          return provider.operations;
        },
        function* (shared) {
          yield* credentials.set("shared");
          yield* access.set(shared);
          const results = yield* runtime.all([() => sibling("a"), () => sibling("b")]);
          // Both child scopes have exited: parent access and policy remain intact.
          expect(yield* credentials.expect()).toBe("shared");
          expect(yield* shared.exchange("parent", "probe")).toEqual({ ok: true, value: "parent" });
          return results;
        },
        function* () {
          yield* runtime.fromPromise((signal) =>
            peer.send({ id: "provider:close", token: "owner" }, signal),
          );
        },
      );
    });
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    const requests = (count: number) =>
      Promise.race([peer.waitForRequests(count), execution.result]);
    await requests(1);
    peer.reply("provider:open", { status: 200, body: "connected" });
    await requests(3);
    expect(
      peer.requests
        .slice(1)
        .map(({ id }) => id)
        .sort(),
    ).toEqual(["a:probe", "b:read"]);
    peer.reply("a:probe", { status: 200, body: "nested" });
    await requests(4);
    peer.reply("a:read", { status: 200, body: "a" });
    await Promise.race([approval.promise, execution.result]);
    cancelA.resolve();
    await requests(5);
    expect(peer.requests.at(-1)).toEqual({ id: "a:release", token: "restricted-a" });
    expect(peer.requests.some(({ id }) => id === "provider:close")).toBe(false);
    peer.reply("a:release", { status: 200, body: "released a" });
    await Promise.race([aSettled.promise, execution.result]);
    expect(peer.aborted).toEqual([]);
    expect(peer.requests).toHaveLength(5);
    // B's already-live request survives A's cancellation and full cleanup.
    peer.reply("b:read", { status: 200, body: "b" });
    await requests(6);
    peer.reply("b:release", { status: 200, body: "released b" });
    await requests(7);
    peer.reply("parent:probe", { status: 200, body: "parent" });
    await requests(8);
    expect(peer.requests).toEqual([
      { id: "provider:open", token: "owner" },
      ...peer.requests.slice(1, 3),
      { id: "a:read", token: "restricted-a" },
      { id: "a:release", token: "restricted-a" },
      { id: "b:release", token: "shared" },
      { id: "parent:probe", token: "shared" },
      { id: "provider:close", token: "owner" },
    ]);
    expect(peer.requests.find(({ id }) => id === "a:probe")?.token).toBe("nested-a");
    expect(peer.requests.find(({ id }) => id === "b:read")?.token).toBe("shared");
    peer.reply("provider:close", { status: 200, body: "closed" });
    const results = await execution.result;
    expectTypeOf(results).toEqualTypeOf<readonly HostedResult<{ text: string }, string>[]>();
    expect(results).toEqual([
      { state: "cancelled", reason: "stop a" },
      { state: "completed", value: { text: "b" } },
    ]);
    expect(peer.aborted).toEqual([]);
  });
});
