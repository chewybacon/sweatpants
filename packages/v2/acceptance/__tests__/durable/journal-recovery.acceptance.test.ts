import { readJournal, historyFrom } from "@sweatpan.ts/testing";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import {
  composeOperation,
  type Around,
  type Middleware,
  type Outcome,
  type Operation,
} from "@standard-durability/core";
import { createRecovery, createCheckpointMiddleware, activateJournal } from "@sweatpan.ts/durable";
import { createLuaEvaluator, luaWasmUrl } from "@sweatpan.ts/codemode-runtime-lua";
import { createMemoryJournal } from "@sweatpan.ts/storage-memory";
import { isDeepStrictEqual } from "node:util";
import type { Work } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createProtocolRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

const source = `
local hold = workflow.effect("reserve", { binding = "reserve", input = input })
local counter = 40
local function bump() counter = counter + 1; return counter end
local approved = workflow.effect("approval", { binding = "approval", input = { hold = hold } })
local count = bump()
workflow.effect("cleanup", { binding = "cleanup", input = { hold = hold, count = count } })
return { hold = hold, approved = approved, count = count }
`;
const program = "reservation-v1:input=booking";
let compiled: Promise<WebAssembly.Module> | undefined;
function loadModule() {
  return (compiled ??= readFile(luaWasmUrl).then((bytes) => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "2d1062f4fffcba8a554331046953831e61a6a70ef3b19bd997b6d459cf732b81",
    );
    return WebAssembly.compile(bytes);
  }));
}
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
  return { site: envelope.site, binding: request.binding, input: request.input };
}
function decodeResult(value: unknown) {
  const result = record(value);
  if (
    typeof result.hold !== "string" ||
    typeof result.approved !== "string" ||
    typeof result.count !== "number"
  ) {
    throw new Error("Invalid result");
  }
  return { hold: result.hold, approved: result.approved, count: result.count };
}
type Request = ReturnType<typeof decodeRequest>;
type Result = ReturnType<typeof decodeResult>;
const matches = (left: Request, right: Request) => JSON.stringify(left) === JSON.stringify(right);

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  describe(`${runtime.name}: journal activation with replay and real Lua checkpoints`, () => {
    const token = runtime.composition.createContext<string>("reservation-token");
    function assembly(name: string) {
      const trace: string[] = [];
      let commands = 0;
      const evaluator = createLuaEvaluator(runtime, {
        source,
        input: "booking",
        decodeRequest,
        decodeResult,
        loadModule() {
          commands++;
          return loadModule();
        },
      });
      // Around composes a callable without changing its inferred Guest result.
      const acquisition: Around<[], ReturnType<typeof evaluator.acquire>> = function* (args, next) {
        trace.push("acquire");
        return yield* next(...args);
      };
      const api = createRecovery(runtime.composition, {
        name,
        program,
        matches,
        acquire: composeOperation(evaluator.acquire, [acquisition]),
      });
      const acceleration = createCheckpointMiddleware({
        execution: api.execution,
        program,
        matches,
        adapter: evaluator.checkpoints,
      });
      // acceleration is OperationMiddleware over actual recovery methods.
      return { api, acceleration, trace, commands: () => commands };
    }

    function run<T>(work: Work<T, Y>) {
      const execution = runtime.start(work);
      void execution.result.catch(() => undefined);
      onTestFinished(() => execution.cancel());
      return execution.result;
    }

    async function acceptReservationAndApproval() {
      const peer = createProtocolRig();
      const journal = createMemoryJournal<Result, Request, unknown, unknown>({
        program,
        equals: isDeepStrictEqual,
      });
      const observed: string[] = [];
      type Domain = { exchange(request: Request): Outcome<string, string> };
      const domain = runtime.composition.createApi<Domain>("reservation:domain", {
        *exchange(request) {
          const credential = yield* token.expect();
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: request.binding, token: credential }, signal),
          );
          return { ok: true, value: reply.body };
        },
      });
      const observation: Middleware<Domain, Y> = {
        *exchange(args, next) {
          observed.push(args[0].binding);
          return yield* next(...args);
        },
      };
      for (const [index, [id, body]] of [
        ["reserve", "hold-7"],
        ["approval", "approved"],
      ].entries()) {
        const host = assembly(`initial:${index}`);
        const activation = await run(function* () {
          yield* host.api.around(host.acceleration);
          return yield* activateJournal(runtime.composition, host.api.operations, journal);
        });
        if (activation.state !== "parked") {
          throw new Error("Expected pending request");
        }
        const delivery = run(function* () {
          yield* token.set("first");
          yield* domain.around(observation);
          const outcome = yield* domain.operations.exchange(activation.pending.request);
          return yield* journal.accept(activation.pending.id, outcome);
        });
        await Promise.race([
          peer.waitForRequests(index + 1),
          delivery.then(() => {
            throw new Error("Delivery ended before peer request");
          }),
        ]);
        peer.reply(id!, { status: 200, body: body! });
        await delivery;
      }
      expect(observed).toEqual(["reserve", "approval"]);
      const snapshot = await run(() => readJournal(journal));
      expect(snapshot.history).toHaveLength(2);
      expect(snapshot.checkpoint?.position).toBe(1);
      // The last answer is committed, but no activation has consumed it yet.
      return { peer, journal, snapshot };
    }

    for (const mode of ["checkpoint", "replay", "unsupported", "disabled"] as const) {
      it(`${mode} activates from the journal and completes without repeating accepted effects`, async () => {
        const saved = await acceptReservationAndApproval();
        // Simulate storage returning an older, unsupported checkpoint format.
        const journal =
          mode === "unsupported"
            ? {
                ...saved.journal,
                *read() {
                  const snapshot = yield* saved.journal.read();
                  return {
                    ...snapshot,
                    checkpoint: snapshot.checkpoint && {
                      ...snapshot.checkpoint,
                      format: "other-format",
                    },
                  };
                },
              }
            : saved.journal;
        function activate(name: string) {
          const host = assembly(name);
          const result = run(function* () {
            if (mode !== "replay") {
              yield* host.api.around(host.acceleration, { at: "min" });
            }
            if (mode === "disabled") {
              yield* host.api.around({
                *recover([plan], next) {
                  return yield* next({ history: plan.history });
                },
              });
            }
            return yield* activateJournal(runtime.composition, host.api.operations, journal);
          });
          return { host, result };
        }
        const resumed = activate(`resume:${mode}`);
        const activation = await resumed.result;
        expect(resumed.host.commands()).toBe(mode === "checkpoint" ? 2 : 3);
        expect(resumed.host.trace).toEqual(mode === "checkpoint" ? [] : ["acquire"]);
        expect(saved.peer.requests.map(({ id }) => id)).toEqual(["reserve", "approval"]);
        if (activation.state !== "parked") {
          throw new Error("Expected cleanup");
        }
        expect(activation.pending.request).toEqual({
          site: "cleanup",
          binding: "cleanup",
          input: { hold: "hold-7", count: 41 },
        });
        const delivery = run(function* () {
          const reply = yield* runtime.fromPromise((signal) =>
            saved.peer.send({ id: "cleanup", token: "second" }, signal),
          );
          return yield* journal.accept(activation.pending.id, { ok: true, value: reply.body });
        });
        await Promise.race([
          saved.peer.waitForRequests(3),
          delivery.then(() => {
            throw new Error("Delivery ended before cleanup request");
          }),
        ]);
        saved.peer.reply("cleanup", { status: 200, body: "released" });
        await delivery;
        const completed = await activate(`complete:${mode}`).result;
        if (completed.state !== "completed") {
          throw new Error("Expected completion");
        }
        expectTypeOf(completed.value).toEqualTypeOf<Result>();
        expect(completed.value).toEqual({ hold: "hold-7", approved: "approved", count: 41 });
        const terminal = activate(`terminal:${mode}`);
        expect(await terminal.result).toEqual(completed);
        expect(terminal.host.commands()).toBe(0);
        expect(saved.peer.requests.map(({ id }) => id)).toEqual(["reserve", "approval", "cleanup"]);
      });
    }

    it("completes an iterator-only application through journal activation", async () => {
      const journal = createMemoryJournal<Result, Request, string, string>({
        program: "iterator-reservation-v1",
        equals: isDeepStrictEqual,
      });
      const peer = createProtocolRig();
      function* request(binding: string, input: unknown): Operation<string, Request> {
        const value: unknown = yield { site: binding, binding, input };
        if (typeof value !== "string") {
          throw new Error("Expected text outcome");
        }
        return value;
      }
      function activate() {
        return run(function* () {
          const recovery = createRecovery(runtime.composition, {
            name: "iterator-recovery",
            program: "iterator-reservation-v1",
            matches,
            *acquire() {
              return createScopedGuest(function* () {
                const hold = yield* request("reserve", "booking");
                const approved = yield* request("approval", { hold });
                yield* request("cleanup", { hold, count: 41 });
                return { hold, approved, count: 41 };
              });
            },
          });
          return yield* activateJournal(runtime.composition, recovery.operations, journal);
        });
      }
      for (const [index, body] of ["hold-7", "approved", "released"].entries()) {
        const activation = await activate();
        if (activation.state !== "parked") {
          throw new Error("Expected request");
        }
        const delivery = run(function* () {
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: activation.pending.request.binding, token: "iterator" }, signal),
          );
          return yield* journal.accept(activation.pending.id, { ok: true, value: reply.body });
        });
        await Promise.race([
          peer.waitForRequests(index + 1),
          delivery.then(() => {
            throw new Error("Delivery ended before request");
          }),
        ]);
        peer.reply(activation.pending.request.binding, { status: 200, body });
        await delivery;
        expect((await run(() => readJournal(journal))).checkpoint).toBeUndefined();
      }
      const completed = await activate();
      if (completed.state !== "completed") {
        throw new Error("Expected completion");
      }
      expectTypeOf(completed.value).toEqualTypeOf<Result>();
      expect(completed.value).toEqual({ hold: "hold-7", approved: "approved", count: 41 });
      expect(peer.requests.map(({ id }) => id)).toEqual(["reserve", "approval", "cleanup"]);
    });

    for (const fault of ["corrupt", "anchor", "program", "history", "divergence"] as const) {
      it(`rejects ${fault} storage on activation without effects or silently restarting`, async () => {
        const saved = await acceptReservationAndApproval();
        const host = assembly(`failure:${fault}`);
        const snapshot = saved.snapshot;
        if (!snapshot.checkpoint) {
          throw new Error("Expected checkpoint");
        }
        let checkpoint = snapshot.checkpoint;
        const history = [...snapshot.history];
        if (fault === "corrupt") {
          checkpoint = { ...checkpoint, state: { invalid: true } };
        }
        if (fault === "anchor") {
          checkpoint = { ...checkpoint, receipt: "wrong" };
        }
        if (fault === "program") {
          checkpoint = { ...checkpoint, program: "other-program" };
        }
        if (fault === "history") {
          history[1] = { ...history[1]!, sequence: 7 };
        }
        if (fault === "divergence") {
          history[1] = {
            ...history[1]!,
            request: { site: "wrong", binding: "wrong", input: null },
          };
        }
        // Fault injection belongs at the storage boundary, not inside recovery.
        const damaged = {
          ...snapshot,
          history: historyFrom(history, snapshot.frontier),
          checkpoint,
        };
        const journal = {
          ...saved.journal,
          *read() {
            return damaged;
          },
        };
        await expect(
          run(function* () {
            yield* host.api.around(host.acceleration);
            return yield* activateJournal(runtime.composition, host.api.operations, journal);
          }),
        ).rejects.toBeDefined();
        expect(await run(() => readJournal(saved.journal))).toEqual(saved.snapshot);
        expect(host.trace).toEqual([]);
        expect(saved.peer.requests).toHaveLength(2);
        expect(host.commands()).toBe(
          fault === "corrupt" || fault === "divergence" || fault === "history" ? 1 : 0,
        );
      });
    }
  });
});
