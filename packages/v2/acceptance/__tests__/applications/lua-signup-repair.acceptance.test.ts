import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import type { OwnedChild, ResolutionGrant } from "@sweatpan.ts/durable";
import { createLuaEvaluator, luaWasmUrl } from "@sweatpan.ts/codemode-runtime-lua";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { childHostingResult, createHosting, createJournalPresentation } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import {
  createHostedRecovery,
  createProtocolRig,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

const source = await readFile(new URL("./signup-repair.lua", import.meta.url), "utf8");
let module: Promise<WebAssembly.Module> | undefined;
const loadModule = () =>
  (module ??= readFile(luaWasmUrl).then((bytes) => WebAssembly.compile(bytes)));
const requestSchema = z.union([
  z.object({
    kind: z.enum(["signup", "reserve", "approve", "commit", "release"]),
    resource: z.string(),
  }),
  z.object({
    kind: z.literal("repair"),
    resource: z.string(),
    operation: z.enum(["reserve", "commit", "release"]),
    failure: z.string(),
  }),
]);
type Request = z.infer<typeof requestSchema>;
const decisionSchema = z.object({
  action: z.enum([
    "confirmed-present",
    "confirmed-absent",
    "confirmed-committed",
    "confirmed-not-committed",
    "confirmed-released",
    "waive",
  ]),
  evidence: z.string().min(1),
});
const allowed = {
  reserve: ["confirmed-present", "confirmed-absent"],
  commit: ["confirmed-committed", "confirmed-not-committed"],
  release: ["confirmed-released", "waive"],
};

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task;
  }
  function scenario(loseAcceptance?: "reserve" | "commit") {
    const store = createSqliteJournalRig<string, Request, unknown, string, unknown, Y>({
      program: "lua-signup-owner-v1",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const resource = `${store.id}:draft`;
    const peer = createProtocolRig();
    let acquisitions = 0;
    let lost = false;
    function assemble() {
      const parent = store.open();
      type Child = OwnedChild<string, Request, unknown, string, unknown, Y>;
      let child: Child | undefined;
      function* bind(requestId: string) {
        child = yield* parent.ensureChild<string, Request, unknown, string>(requestId, {
          program: "lua-signup-reconcile-v1",
          input: { resource },
          outcome: (value) => ({ ok: true, value }),
        });
        return child;
      }
      function* runChild(owned: Child) {
        const lua = createLuaEvaluator(runtime, {
          source,
          input: owned.link.input,
          loadModule,
          decodeRequest(value) {
            return z.object({ request: requestSchema }).parse(value).request;
          },
          decodeResult: (value) => z.string().parse(value),
        });
        const recovery = createHostedRecovery<string, Request, Y, unknown, string>(runtime, {
          name: "lua-signup-recovery",
          program: owned.link.program,
          matches: isDeepStrictEqual,
          *acquire() {
            acquisitions++;
            return yield* lua.acquire();
          },
        });
        const host = createHosting(runtime.composition, {
          name: "lua-signup",
          journal: owned.journal,
          recovery: recovery.operations,
          attempts: owned.journal.attempts,
          interactions: owned.journal.interactions,
          *handle(request: Request): Operation<Outcome<unknown, string>, Y> {
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send({ id: request.kind, token: JSON.stringify(request) }, signal),
            );
            return { ok: true, value: reply.body };
          },
        });
        yield* host.around({
          *deliveryMode([request]) {
            return request.kind === "approve" || request.kind === "repair" ? "wait" : "execute";
          },
        });
        yield* host.attempts.around({
          *settle([grant, outcome], next) {
            const accepted = yield* next(grant, outcome);
            if (!lost && accepted.entry.request.kind === loseAcceptance) {
              lost = true;
              throw new Error("Owner lost after acceptance");
            }
            return accepted;
          },
        });
        return childHostingResult(yield* host.operations.run());
      }
      function* run() {
        const recovery = createHostedRecovery<string, Request, Y, unknown, string>(runtime, {
          name: "lua-owner-recovery",
          program: "lua-signup-owner-v1",
          matches: isDeepStrictEqual,
          *acquire() {
            return createScopedGuest(function* () {
              const result: unknown = yield { kind: "signup", resource };
              return z.string().parse(result);
            });
          },
        });
        const host = createHosting(runtime.composition, {
          name: "lua-owner",
          journal: parent,
          recovery: recovery.operations,
          attempts: parent.attempts,
          *handle(): Operation<Outcome<unknown, string>, Y> {
            throw new Error("Owned signup required");
          },
        });
        yield* host.around({
          *child([pending]) {
            const owned = yield* bind(pending.id);
            return { id: owned.link.childId, run: () => runChild(owned) };
          },
        });
        return yield* host.operations.run();
      }
      return {
        run: () => start(run),
        cancel: () =>
          start(function* () {
            const snapshot = yield* parent.read();
            if (snapshot.status !== "running" || !snapshot.pending) {
              throw new Error("No active signup");
            }
            return yield* parent.cancellation.request(snapshot.pending.id, "signup cancelled");
          }).result,
        observe: () =>
          start(function* () {
            const before = yield* parent.read();
            const intent = yield* store.activations.read();
            if (!child) {
              if (before.status !== "running" || !before.children?.[0]) {
                throw new Error("No active child");
              }
              yield* bind(before.children[0].requestId);
            }
            const root = yield* createJournalPresentation(
              runtime.composition,
              "lua-owner-view",
              parent,
            ).operations.read();
            const leaf = yield* createJournalPresentation(
              runtime.composition,
              "lua-signup-view",
              child!.journal,
            ).operations.read();
            expect((yield* parent.read()).revision).toBe(before.revision);
            expect(yield* store.activations.read()).toEqual(intent);
            return { root, leaf };
          }).result,
        approve: (grant: ResolutionGrant) =>
          start(function* () {
            if (!child) {
              throw new Error("Observe before answering");
            }
            const request = yield* child.journal.interactions.request(grant);
            if (request.kind !== "approve") {
              throw new Error("Not approval");
            }
            return yield* child.journal.interactions.answer(grant, { ok: true, value: "approved" });
          }).result,
        repair: (grant: ResolutionGrant, input: unknown, operator: boolean) =>
          start(function* () {
            if (!operator) {
              throw new Error("Repair authorization required");
            }
            if (!child) {
              throw new Error("Observe before repairing");
            }
            const request = yield* child.journal.interactions.request(grant);
            if (request.kind !== "repair") {
              throw new Error("Not repair");
            }
            const decision = decisionSchema.parse(input);
            if (!allowed[request.operation].includes(decision.action)) {
              throw new Error("Decision does not resolve this operation");
            }
            // Trusted operator attests to a final outcome, including absence of a live
            // delivery that can still change it. A transient lookup is insufficient.
            return yield* child.journal.interactions.answer(grant, { ok: true, value: decision });
          }).result,
      };
    }
    let app = assemble();
    return {
      peer,
      resource,
      get app() {
        return app;
      },
      get acquisitions() {
        return acquisitions;
      },
      reopen() {
        store.reopen();
        app = assemble();
      },
      async begin() {
        const task = app.run();
        await Promise.race([peer.waitForRequests(1), task.result]);
        peer.reply("reserve", { status: 200, body: resource });
        return task.result;
      },
    };
  }
  function waiting(
    view: Awaited<ReturnType<ReturnType<typeof scenario>["app"]["observe"]>>["leaf"],
  ) {
    if (view.state.status !== "running" || view.state.interaction?.state !== "waiting") {
      throw new Error("Expected registered wait");
    }
    return view.state.interaction.grant;
  }

  it.each(["confirmed-released", "waive"] as const)(
    `${runtime.name}: Lua compensation parks for explicit repair and holds its parent (%s)`,
    async (action) => {
      const s = scenario();
      await s.begin();
      const approval = waiting((await s.app.observe()).leaf);
      await s.app.cancel();
      const cleanup = s.app.run();
      await Promise.race([s.peer.waitForRequests(2), cleanup.result]);
      s.peer.reply("release", { status: 200, body: "denied" });
      expect(await cleanup.result).toMatchObject({ state: "child", reason: "waiting" });
      const acquisitions = s.acquisitions;
      s.reopen();
      const view = await s.app.observe();
      expect(s.acquisitions).toBe(acquisitions);
      expect(view.root.state).toMatchObject({
        status: "running",
        cancellationRequested: { reason: "signup cancelled" },
      });
      expect(view.leaf.state).toMatchObject({
        status: "running",
        cancellation: { reason: "signup cancelled" },
        pending: {
          request: { kind: "repair", operation: "release", resource: s.resource },
          scope: { phase: "cleanup" },
        },
      });
      const grant = waiting(view.leaf);
      await s.app.cancel();
      expect(waiting((await s.app.observe()).leaf)).toEqual(grant);
      await expect(s.app.approve(approval)).rejects.toThrow("revoked");
      const decision = { action, evidence: "operator-release-7" };
      await expect(s.app.repair(grant, decision, false)).rejects.toThrow("authorization");
      await expect(
        s.app.repair(grant, { action: "confirmed-committed", evidence: "wrong" }, true),
      ).rejects.toThrow("operation");
      expect((await s.app.repair(grant, decision, true)).duplicate).toBe(false);
      s.reopen();
      await s.app.observe();
      expect((await s.app.repair(grant, decision, true)).duplicate).toBe(true);
      await expect(
        s.app.repair(grant, { ...decision, evidence: "conflict" }, true),
      ).rejects.toThrow();
      expect(await s.app.run().result).toMatchObject({
        state: "cancelled",
        reason: "signup cancelled",
      });
      const settled = await s.app.observe();
      expect(settled.leaf.entries.map((entry) => entry.request.kind)).toEqual([
        "reserve",
        "release",
        "repair",
      ]);
      expect(settled.leaf.entries[1]?.outcome).toEqual({ ok: true, value: "denied" });
      expect(settled.leaf.entries[2]?.outcome).toEqual({ ok: true, value: decision });
      expect(settled.root.state.status).toBe("cancelled");
      expect(s.peer.requests.map((request) => request.id)).toEqual(["reserve", "release"]);
    },
  );

  for (const operation of ["reserve", "commit"] as const) {
    it.each([true, false])(
      `${runtime.name}: Lua ${operation} cancellation fences a late reply and requires final-outcome evidence (external success: %s)`,
      async (succeeded) => {
        const s = scenario();
        let task;
        if (operation === "reserve") {
          task = s.app.run();
          await Promise.race([s.peer.waitForRequests(1), task.result]);
        } else {
          await s.begin();
          await s.app.approve(waiting((await s.app.observe()).leaf));
          task = s.app.run();
          await Promise.race([s.peer.waitForRequests(2), task.result]);
        }
        await s.app.cancel();
        // The external peer may finish after cancellation. Its late reply must not
        // advance the revoked body frontier, even if it reports successful work.
        s.peer.reply(operation, {
          status: 200,
          body: succeeded ? (operation === "reserve" ? s.resource : "committed") : "rejected",
        });
        await expect(task.result).rejects.toThrow("Attempt authority revoked");
        s.reopen();
        expect(await s.app.run().result).toMatchObject({ state: "child", reason: "waiting" });
        const acquired = s.acquisitions;
        s.reopen();
        const view = await s.app.observe();
        expect(s.acquisitions).toBe(acquired);
        expect(view.root.state.status).toBe("running");
        expect(view.leaf.state).toMatchObject({
          status: "running",
          cancellation: { reason: "signup cancelled" },
          pending: {
            request: { kind: "repair", operation, resource: s.resource },
            scope: { phase: "cleanup" },
          },
        });
        expect(view.leaf.entries.map((entry) => entry.request.kind)).toEqual(
          operation === "reserve" ? [] : ["reserve", "approve"],
        );
        const grant = waiting(view.leaf);
        await expect(
          s.app.repair(grant, { action: "waive", evidence: "not enough" }, true),
        ).rejects.toThrow("operation");
        const action =
          operation === "reserve"
            ? succeeded
              ? "confirmed-present"
              : "confirmed-absent"
            : succeeded
              ? "confirmed-committed"
              : "confirmed-not-committed";
        const decision = { action, evidence: "authoritative-service-record-9" };
        await s.app.repair(grant, decision, true);
        const finished = s.app.run();
        const release = operation === "reserve" ? succeeded : !succeeded;
        if (release) {
          await Promise.race([
            s.peer.waitForRequests(operation === "reserve" ? 2 : 3),
            finished.result,
          ]);
          s.peer.reply("release", { status: 200, body: "released" });
        }
        expect(await finished.result).toMatchObject({
          state: "cancelled",
          reason: "signup cancelled",
        });
        const settled = await s.app.observe();
        expect(
          settled.leaf.entries.find((entry) => entry.request.kind === "repair")?.outcome,
        ).toEqual({ ok: true, value: decision });
        const expected = operation === "reserve" ? ["reserve"] : ["reserve", "commit"];
        expect(s.peer.requests.map((request) => request.id)).toEqual([
          ...expected,
          ...(release ? ["release"] : []),
        ]);
      },
    );
  }

  it.each(["reserve", "commit"] as const)(
    `${runtime.name}: Lua reconstructs accepted %s before applying cancellation after owner loss`,
    async (operation) => {
      const s = scenario(operation);
      if (operation === "reserve") {
        await expect(s.begin()).rejects.toThrow("Owner lost after acceptance");
      } else {
        await s.begin();
        await s.app.approve(waiting((await s.app.observe()).leaf));
        const commit = s.app.run();
        await Promise.race([s.peer.waitForRequests(2), commit.result]);
        s.peer.reply("commit", { status: 200, body: "committed" });
        await expect(commit.result).rejects.toThrow("Owner lost after acceptance");
      }
      s.reopen();
      await s.app.cancel();
      const cleanup = s.app.run();
      if (operation === "reserve") {
        await Promise.race([s.peer.waitForRequests(2), cleanup.result]);
        s.peer.reply("release", { status: 200, body: "released" });
      }
      expect(await cleanup.result).toMatchObject({
        state: "cancelled",
        reason: "signup cancelled",
      });
      const view = await s.app.observe();
      expect(view.leaf.entries.some((entry) => entry.request.kind === "repair")).toBe(false);
      expect(s.peer.requests.map((request) => request.id)).toEqual(
        operation === "reserve" ? ["reserve", "release"] : ["reserve", "commit"],
      );
    },
  );

  it(`${runtime.name}: uncertain Lua cleanup delivery stays occupied without invented repair evidence`, async () => {
    const s = scenario();
    await s.begin();
    await s.app.cancel();
    const cleanup = s.app.run();
    await Promise.race([s.peer.waitForRequests(2), cleanup.result]);
    s.peer.fail("release", new Error("Unknown cleanup outcome"));
    await expect(cleanup.result).rejects.toThrow("Unknown cleanup outcome");
    s.reopen();
    expect(await s.app.run().result).toMatchObject({ state: "child", reason: "occupied" });
    const view = await s.app.observe();
    expect(view.root.state.status).toBe("running");
    expect(view.leaf.state).toMatchObject({
      status: "running",
      cancellation: { reason: "signup cancelled" },
      pending: { request: { kind: "release" }, scope: { phase: "cleanup" } },
    });
    expect(view.leaf.entries.map((entry) => entry.request.kind)).toEqual(["reserve"]);
    expect(s.peer.requests.map((request) => request.id)).toEqual(["reserve", "release"]);
  });

  it(`${runtime.name}: successful Lua signup suppresses compensation and terminal reopen acquires no Guest`, async () => {
    const s = scenario();
    await s.begin();
    await s.app.approve(waiting((await s.app.observe()).leaf));
    const task = s.app.run();
    await Promise.race([s.peer.waitForRequests(2), task.result]);
    s.peer.reply("commit", { status: 200, body: "committed" });
    expect(await task.result).toEqual({ state: "completed", value: "active" });
    const acquired = s.acquisitions;
    s.reopen();
    expect(await s.app.run().result).toEqual({ state: "completed", value: "active" });
    expect(s.acquisitions).toBe(acquired);
    expect(s.peer.requests.map((request) => request.id)).toEqual(["reserve", "commit"]);
  });
});
