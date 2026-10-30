import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { serialize, deserialize } from "node:v8";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { Work, Operation } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import {
  createProgramExecution,
  type ProgramInvocation,
  type ResolvedProgram,
} from "@sweatpan.ts/execution";
import { createRecovery, createCheckpointMiddleware } from "@sweatpan.ts/durable";
import {
  createHosting,
  createEffectCapabilities,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import {
  createLuaEvaluator,
  defineLuaEffectBindings,
  luaWasmUrl,
} from "@sweatpan.ts/codemode-runtime-lua";
import {
  createHostedExecution,
  createWorkerGuestRig,
  createSqliteJournalRig,
  createProtocolRig,
} from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

// Identity verification and placement remain provisional application assembly.
const invocationSchema = z.object({ program: z.string(), input: z.object({ topic: z.string() }) });
const lookup = defineEffect({ key: "pinned.lookup", context: z.string(), response: z.string() });
const source = `
local input = ...
local first = workflow.effect("first", { effect = "lookup", input = input.topic })
assert(first.ok)
local second = workflow.effect("second", { effect = "lookup", input = first.value })
assert(second.ok)
return second.value
`;
let moduleBytes: Promise<Buffer> | undefined;

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task;
  }
  for (const placement of ["local", "worker"] as const) {
    for (const checkpoint of [false, true]) {
      it(`${runtime.name} ${placement} (checkpoint ${checkpoint}): pinned Lua acquisition rejects changed artifacts and replays admitted input`, async () => {
        const bytes = await (moduleBytes ??= readFile(luaWasmUrl));
        const evaluatorDigest = createHash("sha256").update(bytes).digest("hex");
        // Include the alias mapping and evaluator artifact, not only authored source.
        // Explicit compatibility assertion for the input/result decoders and effect schemas.
        // Standard Schema cannot reflect the JavaScript implementation of transforms.
        const contractRevision = "topic-input/string-result/lookup-string:v1";
        function identity(body: string, contract = contractRevision) {
          return `lua:sha256:${createHash("sha256")
            .update(
              JSON.stringify({
                source: body,
                evaluatorDigest,
                bindings: { lookup: lookup.id },
                contractRevision: contract,
              }),
            )
            .digest("hex")}`;
        }
        const program = identity(source);
        const store = createSqliteJournalRig<
          string,
          CapabilityRequest,
          unknown,
          string,
          unknown,
          Y
        >({
          program,
          equals: isDeepStrictEqual,
        });
        onTestFinished(() => store.close());
        let journal = store.open();
        const input = { topic: "research" };
        await start(() => journal.admit(program, input)).result;
        input.topic = "mutated after admission";
        const pause = createProtocolRig();
        let acquired = 0;
        let restored = 0;
        let restoreAttempts = 0;
        let partialRestores = 0;
        let releasedRestores = 0;
        let deliveries = 0;
        const topics: string[] = [];
        const routed: string[] = [];

        function run(
          artifact:
            | "original"
            | "missing"
            | "changed"
            | "changed-contract"
            | "unavailable-format"
            | "broken-restore"
            | "absent-adapter",
          delay = false,
          target: "local" | "worker" = placement,
        ) {
          return start(function* () {
            const effects = createEffectCapabilities(runtime, "pinned-effects");
            const grant = effects.grant({ lookup });
            yield* effects.install(lookup, function* (topic) {
              topics.push(topic);
              deliveries++;
              return { ok: true, value: `${topic}!` };
            });
            // Each simulated deployment has its own pinned artifact inventory.
            const inventory = new Map<string, { source: string; contract: string }>();
            if (artifact !== "missing") {
              inventory.set(program, {
                source: artifact === "changed" ? "return 'wrong program'" : source,
                contract: artifact === "changed-contract" ? "lookup-number:v2" : contractRevision,
              });
            }
            const acquisition = runtime.composition.createApi("pinned-acquisition", {
              *resolve(
                invocation: ProgramInvocation<{ topic: string }>,
              ): Operation<ResolvedProgram<string, CapabilityRequest, Y>, Y> {
                const body = inventory.get(invocation.program);
                if (body === undefined) {
                  throw new Error("Pinned program unavailable");
                }
                const bindings = defineLuaEffectBindings({ lookup });
                const evaluator = createLuaEvaluator(runtime, {
                  source: body.source,
                  input: invocation.input,
                  loadModule: () => WebAssembly.compile(new Uint8Array(bytes)),
                  decodeRequest: bindings.decodeRequest,
                  decodeResult: (value) => z.string().parse(value),
                });
                return {
                  program: identity(body.source, body.contract),
                  *acquire() {
                    acquired++;
                    return yield* evaluator.acquire();
                  },
                  checkpoints:
                    artifact === "absent-adapter"
                      ? undefined
                      : {
                          format:
                            artifact === "unavailable-format"
                              ? "other-format"
                              : evaluator.checkpoints.format,
                          capture: evaluator.checkpoints.capture,
                          *restore(state: unknown) {
                            restoreAttempts++;
                            if (artifact === "broken-restore") {
                              const partial = yield* evaluator.checkpoints.restore(state);
                              partialRestores++;
                              yield* runtime.composition.ensure(function* () {
                                yield* partial.guest.close();
                                yield* runtime.fromPromise(async () => {
                                  await Promise.resolve();
                                  releasedRestores++;
                                });
                              });
                              throw new Error("Evaluator restore failed");
                            }
                            const result = yield* evaluator.checkpoints.restore(state);
                            restored++;
                            return result;
                          },
                        },
                };
              },
            });
            yield* acquisition.around({
              *resolve([invocation], next) {
                routed.push(invocation.program);
                // Simulate deployment bootstrap data crossing a serialized boundary.
                // This does not add bootstrap messages to the Guest advancement protocol.
                const startup = serialize(invocation);
                const bound = createProgramExecution({
                  invocation,
                  checkpointFormat: checkpoint ? "piccolo-continuation-4" : undefined,
                  *resolve() {
                    const detached = invocationSchema.parse(deserialize(startup));
                    return yield* next(detached);
                  },
                });
                if (target === "local") {
                  const local = createHostedExecution(runtime, bound);
                  if (!checkpoint) {
                    expect(local.checkpoints).toBeUndefined();
                  }
                  return { program: invocation.program, ...local };
                }
                const worker = createWorkerGuestRig({ runtime, ...bound });
                yield* runtime.composition.ensure(() => runtime.fromPromise(() => worker.close()));
                return {
                  program: invocation.program,
                  acquire: worker.acquire,
                  checkpoints: worker.checkpoints,
                };
              },
            });
            const snapshot = yield* journal.read();
            if (!snapshot.admission) {
              throw new Error("Missing admitted input");
            }
            const selected = yield* acquisition.operations.resolve(
              invocationSchema.parse({
                program: snapshot.program,
                input: snapshot.admission.input,
              }),
            );
            const recovery = createRecovery(runtime.composition, {
              name: "pinned-recovery",
              program,
              matches: isDeepStrictEqual,
              acquire: selected.acquire,
            });
            if (selected.checkpoints) {
              yield* recovery.around(
                createCheckpointMiddleware({
                  program,
                  execution: recovery.execution,
                  adapter: selected.checkpoints,
                  matches: isDeepStrictEqual,
                }),
              );
            }
            const host = createHosting(runtime.composition, {
              name: "pinned-host",
              journal,
              recovery: recovery.operations,
              attempts: {
                begin: journal.attempts.begin,
                *settle(...args: Parameters<typeof journal.attempts.settle>) {
                  const result = yield* journal.attempts.settle(...args);
                  if (delay) {
                    yield* runtime.fromPromise((signal) =>
                      pause.send({ id: "accepted", token: "pause" }, signal),
                    );
                  }
                  return result;
                },
              },
              handle: grant.handle,
            });
            yield* host.around(grant.admission);
            yield* installGuestRetention(runtime.composition, host, recovery, journal);
            return yield* host.operations.run();
          });
        }

        await expect(run("missing").result).rejects.toThrow("Pinned program unavailable");
        await expect(run("changed").result).rejects.toThrow(
          "Resolved program differs from pinned invocation",
        );
        await expect(run("changed-contract").result).rejects.toThrow(
          "Resolved program differs from pinned invocation",
        );
        expect({ acquired, deliveries }).toEqual({ acquired: 0, deliveries: 0 });
        const first = run("original", true);
        await Promise.race([pause.waitForRequests(1), first.result]);
        await first.cancel();
        expect({ acquired, deliveries }).toEqual({ acquired: 1, deliveries: 1 });
        journal = store.reopen();
        const saved = await start(() => journal.read()).result;
        expect(saved.checkpoint !== undefined).toBe(checkpoint);
        await expect(run("changed").result).rejects.toThrow(
          "Resolved program differs from pinned invocation",
        );
        expect({ acquired, deliveries }).toEqual({ acquired: 1, deliveries: 1 });
        await expect(run("changed-contract").result).rejects.toThrow(
          "Resolved program differs from pinned invocation",
        );
        expect(restoreAttempts).toBe(0); // Pin checks precede entry into evaluator restore.
        if (checkpoint) {
          await expect(run("missing").result).rejects.toThrow("Pinned program unavailable");
          await expect(run("unavailable-format").result).rejects.toThrow(
            "Resolved program checkpoint format is unavailable",
          );
          await expect(run("absent-adapter").result).rejects.toThrow(
            "Resolved program checkpoint format is unavailable",
          );
          expect(restoreAttempts).toBe(0);
          await expect(run("broken-restore").result).rejects.toThrow("Evaluator restore failed");
          expect(restoreAttempts).toBe(1);
          expect({ partialRestores, releasedRestores }).toEqual({
            partialRestores: 1,
            releasedRestores: 1,
          });
          expect({ acquired, restored, deliveries }).toEqual({
            acquired: 1,
            restored: 0,
            deliveries: 1,
          });
        }
        // The same admitted invocation may recover on a different placement.
        await expect(
          run("original", false, placement === "local" ? "worker" : "local").result,
        ).resolves.toEqual({
          state: "completed",
          value: "research!!",
        });
        expect({ acquired, restored, deliveries }).toEqual({
          acquired: checkpoint ? 1 : 2,
          restored: checkpoint ? 1 : 0,
          deliveries: 2,
        });
        expect(topics).toEqual(["research", "research!"]);
        expect(routed.every((reference) => reference === program)).toBe(true);
        journal = store.reopen();
        await expect(run("missing").result).resolves.toEqual({
          state: "completed",
          value: "research!!",
        });
        expect(acquired).toBe(checkpoint ? 1 : 2); // Terminal history needs no executable artifact.
      });
    }
  }
});
