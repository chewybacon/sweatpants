import { z } from "zod";
import { createDurableTool } from "@sweatpants/agent-sdk";
import { activateChat } from "@sweatpants/agent-host/primitive/activation";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, run } from "effection";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { assertJson } from "@sweatpants/foundation";
import type { Outcome } from "@sweatpants/standard-durability";
import {
  modelOutcome,
  type ModelSuccess,
} from "../../../experiments/standard-durability/model-api.ts";
import { SqliteJournal } from "@sweatpants/primitive-journal/sqlite";
import { approveRecord } from "../../fixtures/approve-record.ts";
import {
  createScopedChat,
  type ScopedChatCapabilities,
} from "../../../experiments/standard-durability/chat.ts";
import { effect, effectProgram, type EffectYield } from "@sweatpants/standard-durability-effect";
import { effection, type EffectionYield } from "@sweatpants/standard-durability-effection";
import type { Composition, Operation, Work } from "@sweatpants/standard-durability";

interface Host<Y> {
  composition: Composition<Y>;
  start<T>(work: Work<T, Y>): { result: Promise<T>; cancel(): Promise<void> };
  wait<T>(promise: Promise<T>): Operation<T, Y>;
}
const input = {
  messageId: "message-1",
  text: "Please record this",
  modelIdentity: "scripted-model",
  messages: [{ role: "user", content: [{ type: "text", text: "Please record this" }] }],
};
const identity = {
  executionId: "chat-1",
  program: { id: "scoped-chat", version: "1", digest: "scoped-chat-v1" },
  input,
};
const model = {
  id: "scripted-model",
  name: "Scripted model",
  api: "fixture",
  provider: "fixture",
  reasoning: false,
  input: ["text" as const],
  contextWindow: 4096,
  maxTokens: 100,
};
function response(tool: boolean): ModelSuccess {
  return {
    message: {
      role: "assistant",
      content: tool
        ? [
            {
              type: "tool-call",
              toolCall: {
                id: "call-1",
                name: "approve_record",
                input: { topic: "demo" },
                thoughtSignature: null,
              },
            },
          ]
        : [{ type: "text", text: "Finished" }],
    },
    source: null,
    usage: null,
    stopReason: "stop",
    responseId: null,
    errorMessage: null,
  };
}
function transformed(value: ModelSuccess): ModelSuccess {
  return {
    ...value,
    responseId: "middleware-accepted",
    message: {
      ...value.message,
      content: [...value.message.content, { type: "text", text: "[accepted by middleware]" }],
    },
  };
}
function scenarios<Y>(name: string, host: Host<Y>) {
  const c = host.composition;
  describe(`scoped chat activation: ${name}`, () => {
    it("streams, parks for an answer, reopens SQLite and replays only accepted transformed samples", async () => {
      const directory = await mkdtemp(join(tmpdir(), "scoped-chat-"));
      const database = join(directory, "chat.sqlite");
      let journal = new SqliteJournal(database, identity);
      const trace: string[] = [];
      let modelCalls = 0;
      let effectCalls = 0;
      const capabilities: ScopedChatCapabilities<Y> = {
        model: { model, streamOptions: { apiKey: "host-only-fixture", temperature: 0.25 } },
        tools: [approveRecord],
        effects: {
          "approve_record.record": function* () {
            effectCalls++;
            return { ok: true, value: { receipt: "receipt-1" } };
          },
        },
      };
      const activate = () => {
        // Fresh declarations and root bindings simulate a new attachment. No model
        // state is recovered from the old frame; the journal is the authority.
        const chat = createScopedChat(c);
        return host.start(function* () {
          yield* chat.Output.around({
            *publish(args, next) {
              trace.push("output-middleware");
              yield* host.wait(Promise.resolve());
              yield* next(...args);
            },
          });
          yield* chat.Model.host.install({
            *sample(context) {
              const configuration = yield* chat.ModelConfig.expect();
              expect(configuration.model).toBe(model);
              expect(configuration.streamOptions?.apiKey).toBe("host-only-fixture");
              expect(configuration.streamOptions?.temperature).toBe(0.25);
              yield* c.scoped(function* () {
                yield* chat.ModelConfig.set({ model, streamOptions: { temperature: 0.75 } });
                const overridden = yield* chat.ModelConfig.expect();
                expect(overridden.streamOptions?.temperature).toBe(0.75);
              });
              const restored = yield* chat.ModelConfig.expect();
              expect(restored).toBe(configuration);
              const number = modelCalls++;
              trace.push(`acquire:${number}`);
              yield* c.ensure(function* () {
                trace.push(`release:${number}`);
              });
              if (number === 1) {
                expect(context.messages.some((message) => message.role === "tool")).toBe(true);
              }
              const result = response(number === 0);
              yield* host.wait(Promise.resolve());
              yield* chat.Output.operations.publish({ type: "start", partial: result.message });
              return modelOutcome(result);
            },
          });
          yield* chat.Model.host.around({
            *sample(args, next) {
              trace.push("middleware");
              const outcome = yield* next(...args);
              return outcome.ok ? { ok: true, value: transformed(outcome.value) } : outcome;
            },
          });
          const result = yield* chat.activate(capabilities, input, journal, {
            publish() {
              trace.push("publish");
            },
            accepted() {
              trace.push(`accepted:${journal.read().entries.length - 1}`);
            },
          });
          const outside = yield* chat.ModelConfig.get();
          expect(outside).toBeUndefined();
          return result;
        }).result;
      };
      try {
        const parked = await activate();
        expect(parked.state).toBe("parked");
        if (parked.state !== "parked") {
          throw new Error("Expected approval request");
        }
        expect(journal.readAccepted(0)?.request).toMatchObject({
          kind: "api",
          api: "sweatpants.model",
          method: "sample",
          version: "2",
          retrySafety: { mode: "repeatable" },
        });
        expect(JSON.stringify(journal.readAccepted(0)?.request)).not.toContain("host-only-fixture");
        expect(journal.readAccepted(0)?.outcome).toEqual({
          ok: true,
          value: { ok: true, value: assertJson(transformed(response(true))) },
        });
        expect(trace.indexOf("release:0")).toBeLessThan(trace.indexOf("accepted:0"));
        expect(trace.indexOf("publish")).toBeLessThan(trace.indexOf("accepted:0"));
        journal.close();
        journal = new SqliteJournal(database, identity);
        journal.acceptRequest(parked.request.id, {
          ok: true,
          value: { action: "accept", content: { approved: true } },
        });
        const completed = await activate();
        expect(completed.state).toBe("completed");
        expect(modelCalls).toBe(2);
        expect(effectCalls).toBe(1);
        expect(journal.readAccepted(4)?.outcome).toEqual({
          ok: true,
          value: { ok: true, value: assertJson(transformed(response(false))) },
        });
        expect(trace.indexOf("release:1")).toBeLessThan(trace.indexOf("accepted:4"));
        expect(trace.filter((event) => event === "middleware")).toHaveLength(2);
        expect(trace.filter((event) => event === "publish")).toHaveLength(2);
        expect(trace.filter((event) => event === "output-middleware")).toHaveLength(2);
        const beforeReconnect = [...trace];
        journal.close();
        journal = new SqliteJournal(database, identity);
        expect(await activate()).toEqual(completed);
        expect(trace).toEqual(beforeReconnect);
        expect(modelCalls).toBe(2);
        expect(effectCalls).toBe(1);
      } finally {
        journal.close();
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("recovers an accepted sample when delivery was interrupted, without rerunning middleware or the provider", async () => {
      const directory = await mkdtemp(join(tmpdir(), "scoped-chat-delivery-"));
      const database = join(directory, "chat.sqlite");
      let journal = new SqliteJournal(database, identity);
      const capabilities: ScopedChatCapabilities<Y> = { model: { model }, tools: [], effects: {} };
      let calls = 0;
      let middlewareCalls = 0;
      let released = false;
      const activate = (interrupt: boolean) => {
        const chat = createScopedChat(c);
        return host.start(function* () {
          yield* chat.Model.host.install({
            *sample() {
              calls++;
              if (!interrupt) {
                throw new Error("Replay dispatched provider");
              }
              yield* c.ensure(function* () {
                released = true;
              });
              return modelOutcome(response(false));
            },
          });
          yield* chat.Model.host.around({
            *sample(args, next) {
              middlewareCalls++;
              const outcome = yield* next(...args);
              return outcome.ok ? { ok: true, value: transformed(outcome.value) } : outcome;
            },
          });
          return yield* chat.activate(capabilities, input, journal, {
            accepted() {
              expect(released).toBe(true);
              if (interrupt) {
                throw new Error("Lost attachment after acceptance");
              }
            },
          });
        }).result;
      };
      try {
        await expect(activate(true)).rejects.toThrow("Lost attachment after acceptance");
        expect(journal.read().status).toBe("running");
        expect(journal.readAccepted(0)?.outcome).toEqual({
          ok: true,
          value: { ok: true, value: assertJson(transformed(response(false))) },
        });
        journal.close();
        journal = new SqliteJournal(database, identity);
        expect((await activate(false)).state).toBe("completed");
        expect(calls).toBe(1);
        expect(middlewareCalls).toBe(1);
        expect(journal.read().entries).toHaveLength(1);
      } finally {
        journal.close();
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("persists provider failures for replay but leaves invalid success, abort and thrown failures unaccepted", async () => {
      for (const kind of [
        "reported",
        "missing-message",
        "invalid-success",
        "aborted",
        "thrown",
      ] as const) {
        const directory = await mkdtemp(join(tmpdir(), "scoped-model-failure-"));
        const database = join(directory, "chat.sqlite");
        let journal = new SqliteJournal(database, identity);
        let calls = 0;
        let released = false;
        const nativeFailure = new Error("Native provider defect");
        const activate = () => {
          const chat = createScopedChat(c);
          return host.start(function* () {
            yield* chat.Model.host.install({
              *sample() {
                calls++;
                yield* c.ensure(function* () {
                  released = true;
                });
                if (kind === "thrown") {
                  return yield* host.wait(Promise.reject(nativeFailure));
                }
                if (kind === "invalid-success") {
                  // Deliberately violate the provider contract: runtime validation must reject it.
                  return {
                    ok: true,
                    value: {
                      ...response(false),
                      errorMessage: "Hidden failure",
                    } as unknown as ModelSuccess,
                  };
                }
                return modelOutcome({
                  ...response(false),
                  stopReason: kind === "aborted" ? "aborted" : "error",
                  errorMessage: kind === "reported" ? "Provider unavailable" : null,
                });
              },
            });
            return yield* chat.activate(
              { model: { model }, tools: [], effects: {} },
              input,
              journal,
              {
                accepted() {
                  expect(released).toBe(true);
                },
              },
            );
          }).result;
        };
        const expected =
          kind === "reported"
            ? "Provider unavailable"
            : kind === "missing-message"
              ? "Model provider failed"
              : kind === "invalid-success"
                ? "API schema validation failed"
                : kind === "aborted"
                  ? "Model sample aborted"
                  : "Native provider defect";
        try {
          await expect(activate()).rejects.toThrow(expected);
          expect(released).toBe(true);
          const durable = kind === "reported" || kind === "missing-message";
          expect(journal.read().entries).toHaveLength(durable ? 1 : 0);
          if (durable) {
            expect(journal.readAccepted(0)?.outcome).toEqual({
              ok: true,
              value: { ok: false, error: { code: "model-error", message: expected } },
            });
            journal.close();
            journal = new SqliteJournal(database, identity);
            await expect(activate()).rejects.toThrow(expected);
            expect(calls).toBe(1);
          }
        } finally {
          journal.close();
          await rm(directory, { recursive: true, force: true });
        }
      }
    });

    it("isolates concurrent production activations and composes multiple tool declarations in order", async () => {
      const directory = await mkdtemp(join(tmpdir(), "effect-activations-"));
      const inherited = c.createContext<string>("activation-owner");
      const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const traces: string[][] = [[], []];
      const journals = [0, 1].map(
        (id) =>
          new SqliteJournal(join(directory, `${id}.sqlite`), {
            ...identity,
            executionId: `activation-${id}`,
          }),
      );
      const tools = ["first", "second"].map((name) =>
        createDurableTool(name, { version: "1" })
          .description(name)
          .parameters(z.object({}))
          .effects({
            read: {
              version: "1",
              input: z.null(),
              output: z.string(),
              retrySafety: { mode: "repeatable" },
            },
          })
          .execute(function* (_input, ctx) {
            return yield* ctx.effect("read", null);
          }),
      );
      const executions = journals.map((journal, id) =>
        host.start(function* () {
          yield* inherited.set(`owner-${id}`);
          let samples = 0;
          const result = yield* activateChat(
            c,
            {
              tools,
              model: {
                model,
                driver: {
                  *stream() {
                    const result = response(false);
                    if (samples++ === 0) {
                      return {
                        ...result,
                        message: {
                          ...result.message,
                          content: tools.map((tool) => ({
                            type: "tool-call" as const,
                            toolCall: {
                              id: tool.name,
                              name: tool.name,
                              input: {},
                              thoughtSignature: null,
                            },
                          })),
                        },
                      };
                    }
                    return result;
                  },
                },
              },
              effectMiddleware: [
                {
                  *effect([request], next) {
                    traces[id]!.push(`outer:${request.tool}`);
                    const owner = yield* inherited.expect();
                    expect(owner).toBe(`owner-${id}`);
                    yield* c.ensure(function* () {
                      traces[id]!.push(`cleanup:${request.tool}`);
                    });
                    const result = yield* next(request);
                    traces[id]!.push(`returned:${request.tool}`);
                    return result;
                  },
                },
                {
                  *effect([request], next) {
                    traces[id]!.push(`inner:${request.tool}`);
                    return yield* next(request);
                  },
                },
              ],
              effects: Object.fromEntries(
                tools.map((tool) => [
                  `${tool.name}.read`,
                  function* () {
                    traces[id]!.push(`native:${tool.name}`);
                    if (tool.name === "first") {
                      entered[id]!.resolve();
                      yield* host.wait(entered[1 - id]!.promise);
                    }
                    return { ok: true as const, value: `${id}:${tool.name}` };
                  },
                ]),
              ),
            },
            input,
            journal,
          );
          const owner = yield* inherited.expect();
          expect(owner).toBe(`owner-${id}`);
          return result;
        }),
      );
      try {
        await Promise.all(executions.map((execution) => execution.result));
        for (const [id, journal] of journals.entries()) {
          const effects = journal
            .read()
            .entries.filter(
              (entry) =>
                typeof entry.request === "object" &&
                entry.request !== null &&
                "kind" in entry.request &&
                entry.request.kind === "effect",
            );
          expect(effects.map((entry) => entry.outcome)).toEqual([
            { ok: true, value: `${id}:first` },
            { ok: true, value: `${id}:second` },
          ]);
          expect(traces[id]!.slice(0, 8)).toEqual([
            "outer:first",
            "inner:first",
            "native:first",
            "returned:first",
            "outer:second",
            "inner:second",
            "native:second",
            "returned:second",
          ]);
          expect(traces[id]!.slice(8).sort()).toEqual(["cleanup:first", "cleanup:second"]);
        }
      } finally {
        await Promise.all(executions.map((execution) => execution.cancel()));
        journals.forEach((journal) => journal.close());
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("preserves failed effect Outcomes, native failures and cancellation through activation middleware", async () => {
      for (const kind of [
        "reported",
        "invalid",
        "middleware-invalid",
        "thrown",
        "cancelled",
      ] as const) {
        const directory = await mkdtemp(join(tmpdir(), "scoped-effect-failure-"));
        const journal = new SqliteJournal(join(directory, "chat.sqlite"), identity);
        const entered = Promise.withResolvers<void>();
        let released = false;
        let middlewareReleased = false;
        const inherited = c.createContext<string>("effect-inherited");
        let samples = 0;
        const chat = createScopedChat(c);
        const execution = host.start(function* () {
          yield* inherited.set("parent");
          yield* chat.Model.host.install({
            *sample() {
              return { ok: true, value: response(samples++ === 0) };
            },
          });
          return yield* chat.activate(
            {
              model: { model },
              tools: [approveRecord],
              effectMiddleware: [
                {
                  *effect([request], next) {
                    const owner = yield* inherited.expect();
                    expect(owner).toBe("parent");
                    yield* c.ensure(function* () {
                      middlewareReleased = true;
                    });
                    const result = yield* next(request);
                    return kind === "middleware-invalid"
                      ? { ok: true, value: { receipt: 42 } }
                      : result;
                  },
                },
              ],
              effects: {
                *"approve_record.record"() {
                  return yield* c.scoped(function* () {
                    yield* c.ensure(function* () {
                      released = true;
                    });
                    entered.resolve();
                    if (kind === "cancelled") {
                      yield* host.wait(new Promise<void>(() => {}));
                    }
                    if (kind === "thrown") {
                      throw new Error("Native effect defect");
                    }
                    return kind === "reported"
                      ? { ok: false as const, error: { reason: "Record refused" } }
                      : {
                          ok: true as const,
                          value: { receipt: kind === "middleware-invalid" ? "valid" : 42 },
                        };
                  });
                },
              },
            },
            input,
            journal,
          );
        });
        // Observe rejection before cancellation can complete on either native runtime.
        const outcome = execution.result.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          await entered.promise;
          if (kind === "cancelled") {
            await execution.cancel();
          }
          const result = await outcome;
          expect(released).toBe(true);
          expect(middlewareReleased).toBe(true);
          const acceptedEffect = journal.read().entries.find((entry) => {
            const request = entry.request;
            return (
              typeof request === "object" &&
              request !== null &&
              "kind" in request &&
              request.kind === "effect"
            );
          });
          if (kind === "reported") {
            expect(result.ok).toBe(true);
            expect(acceptedEffect?.outcome).toEqual({
              ok: false,
              error: { reason: "Record refused" },
            });
          } else {
            expect(result.ok).toBe(false);
            expect(acceptedEffect).toBeUndefined();
            if (!result.ok && kind !== "cancelled") {
              expect(String(result.error)).toContain(
                kind === "thrown" ? "Native effect defect" : "Journal schema validation failed",
              );
            }
          }
        } finally {
          await execution.cancel();
          journal.close();
          await rm(directory, { recursive: true, force: true });
        }
      }
    });

    it("awaits native sample cleanup on disposal and never accepts provisional streamed output", async () => {
      const journal = new SqliteJournal(":memory:", identity);
      const chat = createScopedChat(c);
      const ready = Promise.withResolvers<void>();
      const cleaning = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let published = false;
      let released = false;
      const execution = host.start(function* () {
        yield* chat.Model.host.install({
          *sample(): Operation<Outcome<ModelSuccess, never>, Y> {
            yield* c.ensure(function* () {
              cleaning.resolve();
              yield* host.wait(release.promise);
              released = true;
            });
            yield* chat.Output.operations.publish({
              type: "start",
              partial: response(false).message,
            });
            ready.resolve();
            return yield* host.wait(new Promise<Outcome<ModelSuccess, never>>(() => {}));
          },
        });
        return yield* chat.activate({ model: { model }, tools: [], effects: {} }, input, journal, {
          publish() {
            published = true;
          },
        });
      });
      const result = execution.result.then(
        () => "completed",
        () => "interrupted",
      );
      try {
        await ready.promise;
        let disposed = false;
        const cancellation = execution.cancel().then(() => {
          disposed = true;
        });
        try {
          await cleaning.promise;
          expect(published).toBe(true);
          expect(disposed).toBe(false);
          expect(journal.read().entries).toHaveLength(0);
        } finally {
          release.resolve();
          await cancellation;
        }
        expect(await result).toBe("interrupted");
        expect(released).toBe(true);
        expect(journal.read().entries).toHaveLength(0);
        expect(journal.read().status).toBe("running");
      } finally {
        release.resolve();
        await execution.cancel();
        journal.close();
      }
    });
  });
}
scenarios<EffectionYield>("Effection", {
  composition: effection,
  start(work) {
    const task = run(work);
    return {
      result: Promise.resolve(task),
      cancel: async () => {
        await task.halt();
      },
    };
  },
  *wait(promise) {
    return yield* call(() => promise);
  },
});
scenarios<EffectYield>("Effect", {
  composition: effect,
  start(work) {
    const controller = new AbortController();
    const result = Effect.runPromise(effectProgram(work), { signal: controller.signal });
    return {
      result,
      cancel: async () => {
        controller.abort();
        await result.catch(() => undefined);
      },
    };
  },
  wait: (promise) => Effect.promise(() => promise),
});
