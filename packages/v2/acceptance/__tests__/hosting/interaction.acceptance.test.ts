import { readJournal } from "@sweatpan.ts/testing";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import { createRecovery, type ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting, type HostedResult } from "@sweatpan.ts/hosting";
import { createMemoryJournal } from "@sweatpan.ts/storage-memory";
import { createProtocolRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

type Request = { kind: "register" } | { kind: "approve"; ticket: string };
type Result = { ticket: string; approval: string };
function* ask(request: Request): Operation<string, Request> {
  const answer: unknown = yield request;
  if (typeof answer !== "string") {
    throw new Error("Expected answer text");
  }
  return answer;
}
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function run<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution.result;
  }
  function scenario(external = false) {
    const journal = createMemoryJournal<Result, Request, string, string>({
      program: "approval",
      equals: isDeepStrictEqual,
    });
    const peer = createProtocolRig();
    let deliveries = 0;
    let attempts = 0;
    let closed = 0;
    let logicalCleanup = 0;
    function assemble() {
      const recovery = createRecovery(runtime.composition, {
        name: "approval-recovery",
        program: "approval",
        matches: isDeepStrictEqual,
        *acquire() {
          const guest = createScopedGuest(function* () {
            const ticket = external ? yield* ask({ kind: "register" }) : "local";
            try {
              const approval = yield* ask({ kind: "approve", ticket });
              return { ticket, approval };
            } finally {
              logicalCleanup++;
            }
          });
          return {
            ...guest,
            *close() {
              yield* guest.close();
              closed++;
            },
          };
        },
      });
      const host = createHosting(runtime.composition, {
        name: "approval-host",
        recovery: recovery.operations,
        journal,
        interactions: journal.interactions,
        attempts: {
          *begin(...args) {
            attempts++;
            return yield* journal.attempts.begin(...args);
          },
          settle: journal.attempts.settle,
        },
        *handle(request: Request): Operation<Outcome<string, string>, Y> {
          deliveries++;
          expect(request.kind).toBe("register");
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: "create-ticket", token: "external-registration" }, signal),
          );
          return { ok: true, value: reply.body };
        },
      });
      return host;
    }
    function activate(mode?: "execute" | "wait") {
      const host = assemble();
      return run(function* () {
        yield* host.around({
          *deliveryMode([request]) {
            return mode ?? (request.kind === "approve" ? "wait" : "execute");
          },
        });
        return yield* host.operations.run();
      });
    }
    const host = assemble();
    return {
      journal,
      peer,
      activate,
      host,
      counts: () => ({ deliveries, attempts, closed, logicalCleanup }),
    };
  }

  it(`${runtime.name}: registers a local elicitation once without an executing attempt`, async () => {
    const s = scenario();
    const parked = await s.activate();
    expectTypeOf(parked).toEqualTypeOf<HostedResult<Result, Request>>();
    if (parked.state !== "waiting") {
      throw new Error("Expected participant wait");
    }
    expect(parked.pending.request).toEqual({ kind: "approve", ticket: "local" });
    expect(await s.activate()).toEqual(parked);
    expect(s.counts()).toEqual({ deliveries: 0, attempts: 0, closed: 2, logicalCleanup: 0 });
    expect((await run(() => readJournal(s.journal))).history).toEqual([]);
    const outcome = { ok: true, value: "yes" } as const;
    const receipt = await run(() => s.host.operations.answer(parked.grant, outcome));
    expect(receipt.entry.request).toEqual(parked.pending.request);
    expect(await run(() => s.host.operations.answer(parked.grant, outcome))).toEqual({
      ...receipt,
      duplicate: true,
    });
    await expect(
      run(() => s.host.operations.answer(parked.grant, { ok: true, value: "no" })),
    ).rejects.toThrow("Conflicting");
    expect(await s.activate()).toEqual({
      state: "completed",
      value: { ticket: "local", approval: "yes" },
    });
    expect(s.counts().deliveries).toBe(0);
    expect(s.counts().logicalCleanup).toBe(1);
  });

  for (const winner of ["answer", "invalidation"] as const) {
    it(`${runtime.name}: atomically resolves answer versus external invalidation (${winner} wins)`, async () => {
      const s = scenario();
      const parked = await s.activate();
      if (parked.state !== "waiting") {
        throw new Error("Expected participant wait");
      }
      const events = createProtocolRig();
      const answer = run(function* () {
        const reply = yield* runtime.fromPromise((signal) =>
          events.send({ id: "answer", token: parked.grant.resolutionId }, signal),
        );
        return yield* s.host.operations.answer(parked.grant, { ok: true, value: reply.body });
      });
      const invalidate = run(function* () {
        yield* runtime.fromPromise((signal) =>
          events.send({ id: "invalidation", token: parked.grant.resolutionId }, signal),
        );
        return yield* s.host.operations.invalidate(parked.grant, "scope expired");
      });
      await Promise.race([events.waitForRequests(2), answer, invalidate]);
      events.reply(winner, { status: 200, body: "yes" });
      if (winner === "answer") {
        const accepted = await answer;
        events.reply("invalidation", { status: 200, body: "expire" });
        expect(await invalidate).toEqual({
          state: "accepted",
          acceptance: { ...accepted, duplicate: true },
        });
        expect(await s.activate()).toEqual({
          state: "completed",
          value: { ticket: "local", approval: "yes" },
        });
      } else {
        expect(await invalidate).toEqual({ state: "invalidated", reason: "scope expired" });
        events.reply("answer", { status: 200, body: "yes" });
        await expect(answer).rejects.toThrow("authority revoked");
        expect(await s.activate()).toEqual({
          ...parked,
          state: "invalidated",
          reason: "scope expired",
        });
        expect(
          await run(() => s.host.operations.invalidate(parked.grant, "another reason")),
        ).toEqual({ state: "invalidated", reason: "scope expired" });
        expect((await run(() => readJournal(s.journal))).history).toEqual([]);
        expect(s.counts().logicalCleanup).toBe(0); // Fencing is not workflow unwinding.
      }
      expect(s.counts().attempts).toBe(0);
    });
  }

  it(`${runtime.name}: rejects foreign authority and prevents changing a registered wait into execution`, async () => {
    const s = scenario();
    const parked = await s.activate();
    if (parked.state !== "waiting") {
      throw new Error("Expected participant wait");
    }
    const foreign: ResolutionGrant = { ...parked.grant, resolutionId: "foreign" };
    await expect(
      run(() => s.host.operations.answer(foreign, { ok: true, value: "yes" })),
    ).rejects.toThrow("Unknown resolution");
    await expect(run(() => s.host.operations.invalidate(foreign, "stop"))).rejects.toThrow(
      "Unknown resolution",
    );
    await expect(s.activate("execute")).rejects.toThrow("Participant registration excludes");
    expect(await s.activate()).toEqual(parked);
    expect(s.counts().deliveries).toBe(0);
  });

  it(`${runtime.name}: composes external registration with participant waiting without repeating creation`, async () => {
    const s = scenario(true);
    const activation = s.activate();
    await Promise.race([
      s.peer.waitForRequests(1),
      activation.then(() => {
        throw new Error("Host ended before registration");
      }),
    ]);
    s.peer.reply("create-ticket", { status: 200, body: "ticket-1" });
    const parked = await activation;
    if (parked.state !== "waiting") {
      throw new Error("Expected participant wait");
    }
    expect(parked.pending.request).toEqual({ kind: "approve", ticket: "ticket-1" });
    expect((await run(() => readJournal(s.journal))).history).toHaveLength(1);
    expect(await s.activate()).toEqual(parked);
    await run(() => s.host.operations.answer(parked.grant, { ok: true, value: "approved" }));
    expect(await s.activate()).toEqual({
      state: "completed",
      value: { ticket: "ticket-1", approval: "approved" },
    });
    expect(s.counts().attempts).toBe(1);
    expect(s.counts().deliveries).toBe(1);
    expect(s.peer.requests).toHaveLength(1);
  });
});
