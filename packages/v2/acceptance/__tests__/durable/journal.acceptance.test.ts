import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Work } from "@standard-durability/core";
import {
  activateJournal,
  createRecovery,
  createCheckpointMiddleware,
  type Activation,
} from "@sweatpan.ts/durable";
import { createMemoryJournal } from "@sweatpan.ts/storage-memory";
import { createLuaEvaluator, luaWasmUrl } from "@sweatpan.ts/codemode-runtime-lua";
import { createScopedGuest, type Guest } from "@sweatpan.ts/execution";
import { createProtocolRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

let compiled: Promise<WebAssembly.Module> | undefined;
const source = `
local hold = workflow.effect("reserve", { binding = "reserve" })
local approval = workflow.effect("approve", { binding = "approve", hold = hold })
return { hold = hold, approval = approval }
`;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected record");
  }
  return value as Record<string, unknown>;
}
function decodeRequest(value: unknown) {
  const envelope = record(value);
  const request = record(envelope.request);
  if (typeof envelope.site !== "string" || typeof request.binding !== "string") {
    throw new Error("Invalid request");
  }
  return { site: envelope.site, binding: request.binding, hold: request.hold };
}
function decodeResult(value: unknown) {
  const result = record(value);
  if (typeof result.hold !== "string" || typeof result.approval !== "string") {
    throw new Error("Invalid result");
  }
  return { hold: result.hold, approval: result.approval };
}
type Request = ReturnType<typeof decodeRequest>;
type Result = ReturnType<typeof decodeResult>;

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function run<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution.result;
  }
  describe(`${runtime.name}: journal-owned acceptance and activation`, () => {
    for (const checkpoints of [false, true]) {
      it(`replaces hosts at every park with journal-owned receipts (checkpoints: ${checkpoints})`, async () => {
        const journal = createMemoryJournal<Result, Request, unknown, unknown>({
          program: "booking:v1",
          equals: isDeepStrictEqual,
        });
        const peer = createProtocolRig();
        const guests: Guest<Result, Request, Y>[] = [];
        let commands = 0;
        function activate() {
          // Fresh host API, evaluator and native scope. Only journal/peer state persists.
          return run(function* () {
            const evaluator = createLuaEvaluator(runtime, {
              source,
              input: null,
              decodeRequest,
              decodeResult,
              loadModule() {
                commands++;
                return (compiled ??= readFile(luaWasmUrl).then((bytes) =>
                  WebAssembly.compile(bytes),
                ));
              },
            });
            const recovery = createRecovery(runtime.composition, {
              name: "journal-recovery",
              program: "booking:v1",
              acquire: evaluator.acquire,
              matches: isDeepStrictEqual,
            });
            if (checkpoints) {
              yield* recovery.around(
                createCheckpointMiddleware({
                  execution: recovery.execution,
                  program: "booking:v1",
                  adapter: evaluator.checkpoints,
                  matches: isDeepStrictEqual,
                }),
                { at: "min" },
              );
            }
            yield* recovery.around({
              *recover(args, next) {
                const restored = yield* next(...args);
                guests.push(restored.guest);
                return restored;
              },
            });
            return yield* activateJournal(runtime.composition, recovery.operations, journal);
          });
        }
        let activation = await activate();
        expectTypeOf(activation).toEqualTypeOf<Activation<Result, Request>>();
        expect(commands).toBe(1);
        if (activation.state !== "parked") {
          throw new Error("Expected reserve");
        }
        const first = activation.pending;
        expect(first.sequence).toBe(0);
        const initial = await run(() => journal.read());
        expect(initial.history).toEqual([]);
        expect(initial.checkpoint?.position).toBe(checkpoints ? 0 : undefined);
        // An unanswered request survives host replacement with the same delivery identity.
        expect(await activate()).toEqual(activation);
        await expect(run(() => guests[0]!.resume({ ok: true, value: "stale" }))).rejects.toThrow(
          "closed",
        );
        const beforeAcceptance = commands;
        const delivery = run(function* () {
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: "reserve", token: first.id }, signal),
          );
          return yield* journal.accept(first.id, { ok: true, value: reply.body });
        });
        await peer.waitForRequests(1);
        peer.reply("reserve", { status: 200, body: "hold-9" });
        const accepted = await delivery;
        expect(accepted.duplicate).toBe(false);
        expect(commands).toBe(beforeAcceptance); // Acceptance itself does not advance compute.
        const afterAcceptance = await run(() => journal.read());
        expect(afterAcceptance.history).toHaveLength(1);
        expect(afterAcceptance.history[0]?.receipt).toBe(accepted.entry.receipt);
        // The accepting host is gone before any resume. A new activation catches up.
        activation = await activate();
        if (activation.state !== "parked") {
          throw new Error("Expected approval");
        }
        const second = activation.pending;
        expect(second.sequence).toBe(1);
        expect(second.id).not.toBe(first.id);
        expect(second.request.hold).toBe("hold-9");
        const atApproval = await run(() => journal.read());
        expect(atApproval.checkpoint?.position).toBe(checkpoints ? 1 : undefined);
        expect(atApproval.checkpoint?.receipt).toBe(
          checkpoints ? accepted.entry.receipt : undefined,
        );
        const duplicate = await run(() => journal.accept(first.id, { ok: true, value: "hold-9" }));
        expect(duplicate).toEqual({ ...accepted, duplicate: true });
        await expect(
          run(() => journal.accept(first.id, { ok: true, value: "different" })),
        ).rejects.toThrow("Conflicting");
        await expect(
          run(() => journal.accept("foreign-request", { ok: true, value: "wrong" })),
        ).rejects.toThrow("Stale");
        expect(await run(() => journal.read())).toEqual(atApproval);
        const approval = run(function* () {
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: "approve", token: second.id }, signal),
          );
          return yield* journal.accept(second.id, { ok: true, value: reply.body });
        });
        await peer.waitForRequests(2);
        peer.reply("approve", { status: 200, body: "approved" });
        await approval;
        activation = await activate();
        expect(activation).toEqual({
          state: "completed",
          value: { hold: "hold-9", approval: "approved" },
        });
        expect(commands).toBe(checkpoints ? 6 : 7);
        const completedCommands = commands;
        expect(await activate()).toEqual(activation);
        expect(commands).toBe(completedCommands); // Stored completion acquires no evaluator.
        const stored = await run(() => journal.read());
        expect(stored.status).toBe("completed");
        expect(stored.history).toHaveLength(2);
        expect(peer.requests.map(({ id }) => id)).toEqual(["reserve", "approve"]);
        for (const guest of guests) {
          await expect(run(() => guest.resume({ ok: true, value: "stale" }))).rejects.toThrow(
            "closed",
          );
        }
        expect(
          (await run(() => journal.accept(second.id, { ok: true, value: "approved" }))).duplicate,
        ).toBe(true);
      });
    }

    it("rejects a stale activation commit and disposes both competing Guests", async () => {
      const journal = createMemoryJournal<number, string, unknown, unknown>({
        program: "race",
        equals: isDeepStrictEqual,
      });
      const gates = createProtocolRig();
      const guests: Guest<number, string, never>[] = [];
      function host(id: string) {
        return run(function* () {
          const recovery = createRecovery(runtime.composition, {
            name: "race-recovery",
            program: "race",
            matches: isDeepStrictEqual,
            *acquire() {
              const guest = createScopedGuest(function* () {
                yield "question";
                return 1;
              });
              guests.push(guest);
              return guest;
            },
          });
          yield* recovery.around({
            *recover(args, next) {
              const recovered = yield* next(...args);
              yield* runtime.fromPromise((signal) =>
                gates.send({ id, token: "ready-to-commit" }, signal),
              );
              return recovered;
            },
          });
          return yield* activateJournal(runtime.composition, recovery.operations, journal);
        });
      }
      const first = host("first");
      const second = host("second");
      await gates.waitForRequests(2);
      gates.reply("first", { status: 200, body: "commit" });
      const winner = await first;
      gates.reply("second", { status: 200, body: "commit" });
      await expect(second).rejects.toThrow("revision conflict");
      const snapshot = await run(() => journal.read());
      expect(snapshot.history).toEqual([]);
      expect(snapshot.revision).toBe(1);
      expect(snapshot.status === "running" && snapshot.pending).toEqual(
        winner.state === "parked" && winner.pending,
      );
      for (const guest of guests) {
        await expect(run(() => guest.start())).rejects.toThrow("closed");
      }
    });

    it("rejects a wrong checkpoint anchor and isolates stored data from caller mutation", async () => {
      const journal = createMemoryJournal<number, { id: string }, string, string>({
        program: "anchor",
        equals: isDeepStrictEqual,
      });
      function activate(invalidCheckpoint = false) {
        return run(function* () {
          const recovery = createRecovery(runtime.composition, {
            name: "anchor-recovery",
            program: "anchor",
            matches: isDeepStrictEqual,
            *acquire() {
              return createScopedGuest(function* () {
                yield { id: "request" };
                yield { id: "next" };
                return 1;
              });
            },
          });
          if (invalidCheckpoint) {
            yield* recovery.around({
              *checkpoint() {
                return {
                  program: "anchor",
                  format: "fixture",
                  position: 1,
                  receipt: "wrong",
                  state: {},
                };
              },
            });
          }
          return yield* activateJournal(runtime.composition, recovery.operations, journal);
        });
      }
      const activation = await activate();
      if (activation.state !== "parked") {
        throw new Error("Expected request");
      }
      const pending = activation.pending;
      const accepted = await run(() => journal.accept(pending.id, { ok: true, value: "answer" }));
      const snapshot = await run(() => journal.read());
      await expect(activate(true)).rejects.toThrow("Checkpoint differs");
      expect(await run(() => journal.read())).toEqual(snapshot);
      accepted.entry.request.id = "mutated";
      pending.request.id = "mutated";
      snapshot.history[0]!.request.id = "mutated";
      expect((await run(() => journal.read())).history[0]?.request.id).toBe("request");
    });
  });
});
