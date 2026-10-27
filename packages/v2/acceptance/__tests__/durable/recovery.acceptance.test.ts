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
import {
  createRecovery,
  createCheckpointMiddleware,
  type Accepted,
  type Checkpoint,
} from "@sweatpan.ts/durable";
import { createLuaEvaluator, luaWasmUrl } from "@sweatpan.ts/codemode-runtime-lua";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createIteratorGuest, type Turn } from "@sweatpan.ts/execution";
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
type Entry = Accepted<Request, unknown, unknown>;
const matches = (left: Request, right: Request) => JSON.stringify(left) === JSON.stringify(right);

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  describe(`${runtime.name}: replay and real Lua checkpoint recovery`, () => {
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
      const acceleration = createCheckpointMiddleware(runtime.composition, {
        program,
        matches,
        adapter: evaluator.checkpoints,
      });
      // acceleration is OperationMiddleware over actual recovery methods.
      return { api, acceleration, trace, commands: () => commands };
    }

    async function firstActivation() {
      const peer = createProtocolRig();
      const host = assembly("recovery:first");
      const history: Entry[] = [];
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
      // Middleware is the value-signature shorthand on the business API.
      const observation: Middleware<Domain, Y> = {
        *exchange(args, next) {
          observed.push(args[0].binding);
          return yield* next(...args);
        },
      };
      const execution = runtime.start(function* () {
        yield* token.set("first");
        yield* domain.around(observation);
        yield* host.api.around(host.acceleration, { at: "min" });
        let recovered = yield* host.api.operations.recover({ history });
        let snapshot: Checkpoint<unknown> | undefined;
        for (let index = 0; index < 2; index++) {
          if (recovered.turn.kind !== "suspended") {
            throw new Error("Expected suspension");
          }
          const request = recovered.turn.request;
          const outcome = yield* domain.operations.exchange(request);
          history.push({ sequence: index, receipt: `accepted:${index}`, request, outcome });
          const turn = yield* recovered.guest.resume(outcome);
          recovered = { ...recovered, turn, position: history.length };
          if (index === 0) {
            snapshot = yield* host.api.operations.checkpoint(recovered, history);
          }
        }
        if (!snapshot) {
          throw new Error("Expected actual checkpoint");
        }
        return { snapshot, frontier: recovered.turn, guest: recovered.guest };
      });
      void execution.result.catch(() => undefined);
      onTestFinished(() => execution.cancel());
      for (const [index, [id, body]] of [
        ["reserve", "hold-7"],
        ["approval", "approved"],
      ].entries()) {
        await Promise.race([
          peer.waitForRequests(index + 1),
          execution.result.then(() => {
            throw new Error("Execution ended before peer request");
          }),
        ]);
        peer.reply(id!, { status: 200, body: body! });
      }
      const saved = await execution.result;
      expect(observed).toEqual(["reserve", "approval"]);
      expect(host.commands()).toBe(3); // start + two accepted outcomes
      // The first scope has actually disposed its live continuation.
      await expect(
        runtime.start(() => saved.guest.resume({ ok: true, value: "stale" })).result,
      ).rejects.toThrow("closed");
      return {
        peer,
        history: structuredClone(history),
        snapshot: structuredClone(saved.snapshot),
        frontier: saved.frontier,
      };
    }

    for (const mode of ["checkpoint", "replay", "unsupported", "disabled"] as const) {
      it(`${mode} reaches the same frontier, then completes without repeating accepted effects`, async () => {
        const saved = await firstActivation();
        const host = assembly(`recovery:${mode}`);
        const snapshot =
          mode === "unsupported" ? { ...saved.snapshot, format: "other-format" } : saved.snapshot;
        const execution = runtime.start(function* () {
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
          const recovered = yield* host.api.operations.recover({
            history: saved.history,
            checkpoint: snapshot,
          });
          expect(recovered.turn).toEqual(saved.frontier);
          expect(host.commands()).toBe(mode === "checkpoint" ? 2 : 3);
          expect(host.trace).toEqual(mode === "checkpoint" ? [] : ["acquire"]);
          expect(saved.peer.requests.map(({ id }) => id)).toEqual(["reserve", "approval"]);
          if (recovered.turn.kind !== "suspended") {
            throw new Error("Expected cleanup");
          }
          const reply = yield* runtime.fromPromise((signal) =>
            saved.peer.send({ id: "cleanup", token: "second" }, signal),
          );
          const outcome = { ok: true, value: reply.body } as const;
          saved.history.push({
            sequence: 2,
            receipt: "accepted:2",
            request: recovered.turn.request,
            outcome,
          });
          const turn = yield* recovered.guest.resume(outcome);
          if (turn.kind !== "completed") {
            throw new Error("Expected completion");
          }
          expectTypeOf(turn.value).toEqualTypeOf<{
            hold: string;
            approved: string;
            count: number;
          }>();
          return turn.value;
        });
        void execution.result.catch(() => undefined);
        onTestFinished(() => execution.cancel());
        await Promise.race([
          saved.peer.waitForRequests(3),
          execution.result.then(() => {
            throw new Error("Execution ended before cleanup request");
          }),
        ]);
        saved.peer.reply("cleanup", { status: 200, body: "released" });
        expect(await execution.result).toEqual({ hold: "hold-7", approved: "approved", count: 41 });
        expect(saved.peer.requests.map(({ id }) => id)).toEqual(["reserve", "approval", "cleanup"]);
        // Reconstruct terminal state from retained history too: no peer calls.
        const terminal = assembly(`terminal:${mode}`);
        const result = await runtime.start(function* () {
          if (mode === "checkpoint") {
            yield* terminal.api.around(terminal.acceleration);
          }
          return (yield* terminal.api.operations.recover({
            history: saved.history,
            checkpoint: snapshot,
          })).turn;
        }).result;
        expect(result).toEqual({
          kind: "completed",
          value: { hold: "hold-7", approved: "approved", count: 41 },
        });
        expect(saved.peer.requests).toHaveLength(3);
      });
    }

    it("replays accepted history into an ordinary iterator without checkpoint capabilities", async () => {
      const saved = await firstActivation();
      function* request(binding: string, input: unknown): Operation<string, Request> {
        const value: unknown = yield { site: binding, binding, input };
        if (typeof value !== "string") {
          throw new Error("Expected text outcome");
        }
        return value;
      }
      const recovery = createRecovery(runtime.composition, {
        name: "iterator-recovery",
        program: "iterator-reservation-v1",
        matches,
        *acquire() {
          return createIteratorGuest(function* () {
            const hold = yield* request("reserve", "booking");
            const approved = yield* request("approval", { hold });
            yield* request("cleanup", { hold, count: 41 });
            return { hold, approved, count: 41 };
          });
        },
      });
      const execution = runtime.start(function* () {
        const recovered = yield* recovery.operations.recover({ history: saved.history });
        expect(recovered.turn).toEqual(saved.frontier);
        const checkpoint = yield* recovery.operations.checkpoint(recovered, saved.history);
        expect(checkpoint).toBeUndefined();
        return recovered.turn;
      });
      const turn = await execution.result;
      expectTypeOf(turn).toEqualTypeOf<
        Turn<{ hold: string; approved: string; count: number }, Request>
      >();
      expect(saved.peer.requests).toHaveLength(2);
    });

    for (const fault of ["corrupt", "anchor", "program", "history", "divergence"] as const) {
      it(`rejects ${fault} recovery without executing business effects or silently restarting`, async () => {
        const saved = await firstActivation();
        const host = assembly(`failure:${fault}`);
        let checkpoint = saved.snapshot;
        const history = saved.history;
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
        const execution = runtime.start(function* () {
          yield* host.api.around(host.acceleration);
          return yield* host.api.operations.recover({ history, checkpoint });
        });
        await expect(execution.result).rejects.toBeDefined();
        expect(host.trace).toEqual([]);
        expect(saved.peer.requests).toHaveLength(2);
        expect(host.commands()).toBe(fault === "corrupt" || fault === "divergence" ? 1 : 0);
      });
    }
  });
});
