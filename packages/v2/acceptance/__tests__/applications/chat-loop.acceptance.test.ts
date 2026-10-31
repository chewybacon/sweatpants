import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import {
  streamChat,
  createChatModel,
  createChatSampling,
  limitChatRounds,
  type ChatLoopRequest,
  type ChatLoopSample,
  type ChatSamplingError,
  runChat,
  type ChatLoopOptions,
  type ChatLoopResult,
  type ChatLoopEvent,
} from "@sweatpan.ts/chat";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createScopedGuest, type ScopeInstruction } from "@sweatpan.ts/execution";
import {
  createEffectCapabilities,
  createHosting,
  createJournalPresentation,
} from "@sweatpan.ts/hosting";
import { createHostedRecovery, createSqliteJournalRig } from "@sweatpan.ts/testing";
import type { ChatToolCall, ModelResponse, ModelInfo } from "@sweatpan.ts/providers";
import type { Runtime, Subscription } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

const batch = z.object({
  text: z.string(),
  calls: z.array(z.object({ id: z.string(), name: z.string(), input: z.string() })),
});
const sample = defineEffect({
  key: "loop.sample",
  context: z.custom<ChatLoopRequest>(),
  response: z.custom<ChatLoopSample>(),
});
const samplingError = z.custom<ChatSamplingError>();
const alpha = defineEffect({ key: "loop.alpha", context: z.string(), response: z.string() });
const beta = defineEffect({ key: "loop.beta", context: z.string(), response: z.string() });
// Local trusted progress exchange; application ingress schemas are a separate boundary.
const progress = defineEffect({
  key: "loop.progress",
  context: z.custom<ChatLoopEvent>(),
  response: z.null(),
});
const model: ModelInfo = {
  id: "model",
  provider: "script",
  api: "script",
  name: "Model",
  input: ["text"],
  output: ["text"],
  contextWindow: 4096,
  maxOutputTokens: 128,
  reasoningLevels: [],
};
function response(value: z.infer<typeof batch>): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: [
        { type: "text", text: value.text },
        ...value.calls.map((call) => ({
          type: "tool-call" as const,
          toolCall: { ...call, thoughtSignature: null },
        })),
      ],
    },
    source: null,
    usage: null,
    stopReason: null,
    responseId: null,
    errorMessage: null,
  };
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function scenario(
    mode:
      | "success"
      | "authored-failure"
      | "delivery-error"
      | "progress-error"
      | "unknown"
      | "duplicate"
      | "reused"
      | "limit"
      | "catalog"
      | "wrong-model",
  ) {
    const store = createSqliteJournalRig<
      ChatLoopResult,
      CapabilityRequest,
      unknown,
      string,
      unknown,
      Y
    >({ program: `loop:${mode}`, equals: isDeepStrictEqual });
    onTestFinished(() => store.close());
    const counts = { samples: 0, alpha: 0, beta: 0, acquired: 0, events: 0 };
    const initial = [{ role: "user" as const, content: "Research" }];
    function assemble() {
      const journal = store.open();
      const effects = createEffectCapabilities(runtime, "loop-effects");
      const grant = effects.grant({ sample, alpha, beta, progress });
      const recovery = createHostedRecovery<ChatLoopResult, CapabilityRequest, Y, unknown, string>(
        runtime,
        {
          name: "loop-recovery",
          program: `loop:${mode}`,
          matches: isDeepStrictEqual,
          *acquire() {
            counts.acquired++;
            return createScopedGuest(function* (scope) {
              const tools = [
                {
                  definition: { name: "alpha", description: null, parameters: { type: "string" } },
                  *call(call: ChatToolCall) {
                    const result = yield* grant.capabilities.alpha(z.string().parse(call.input));
                    return result.ok
                      ? { content: result.value, isError: false }
                      : { content: "Authored refusal", isError: true };
                  },
                },
                {
                  definition: { name: "beta", description: null, parameters: { type: "string" } },
                  *call(call: ChatToolCall) {
                    const result = yield* grant.capabilities.beta(z.string().parse(call.input));
                    return result.ok
                      ? { content: result.value, isError: false }
                      : { content: "Authored refusal", isError: true };
                  },
                },
              ];
              const options: ChatLoopOptions = {
                history: initial,
                tools: mode === "catalog" ? [tools[0]!, tools[0]!] : tools,
                *event(event) {
                  const accepted = yield* grant.capabilities.progress(event);
                  if (!accepted.ok) {
                    throw new Error("Progress rejected");
                  }
                },
                *sample(request) {
                  const sampled = yield* grant.capabilities.sample(request);
                  return sampled.ok
                    ? sampled
                    : { ok: false, error: samplingError.parse(sampled.error) };
                },
              };
              // Exercise stream-first consumption; the provider journey uses runChat.
              return yield* scope.scoped(function* (owner) {
                const events = yield* streamChat(owner, options);
                while (true) {
                  const item = yield* events.next();
                  if (item.done) {
                    return item.value;
                  }
                  yield* options.event!(item.value);
                }
              });
            });
          },
        },
      );
      const host = createHosting(runtime.composition, {
        name: "loop-host",
        journal,
        recovery: recovery.operations,
        attempts: journal.attempts,
        interactions: journal.interactions,
        handle: grant.handle,
      });
      const presentation = createJournalPresentation(
        runtime.composition,
        "loop-presentation",
        journal,
      );
      return {
        read() {
          const task = runtime.start(() => presentation.operations.read());
          onTestFinished(() => task.cancel());
          return task.result;
        },
        run(maxRounds = mode === "limit" ? 1 : 4) {
          const task = runtime.start(function* () {
            yield* effects.install(progress, function* (event) {
              counts.events++;
              if (mode === "progress-error" && event.type === "tool-started") {
                throw new Error("Progress transport failed");
              }
              return { ok: true as const, value: null };
            });
            const models = createChatModel(runtime.composition, "loop-models", {
              *select() {
                return model;
              },
            });
            const sampling = createChatSampling(runtime.composition, "loop-sampling", {
              model: models.operations,
              *sample(selected, { round }) {
                counts.samples++;
                const value =
                  round === 0
                    ? {
                        text: "Working",
                        calls: [
                          { id: "a1", name: "alpha", input: "first" },
                          {
                            id: mode === "duplicate" ? "a1" : "b1",
                            name: mode === "unknown" ? "missing" : "beta",
                            input: "approve",
                          },
                        ],
                      }
                    : round === 1
                      ? {
                          text: "More",
                          calls: [
                            { id: mode === "reused" ? "a1" : "a2", name: "alpha", input: "second" },
                          ],
                        }
                      : { text: "Done", calls: [] };
                return {
                  model: mode === "wrong-model" ? { ...selected, id: "other" } : selected,
                  response: response(value),
                };
              },
            });
            yield* sampling.around(limitChatRounds(maxRounds));
            yield* effects.install(sample, sampling.operations.sample);
            yield* effects.install(alpha, function* (input) {
              counts.alpha++;
              if (mode === "delivery-error") {
                throw new Error("Tool transport failed");
              }
              if (mode === "authored-failure") {
                return { ok: false as const, error: "declined" };
              }
              return { ok: true as const, value: `alpha:${input}` };
            });
            yield* effects.install(beta, function* () {
              counts.beta++;
              throw new Error("Expected participant wait");
            });
            yield* host.around(grant.admission);
            yield* host.around({
              *deliveryMode([request]) {
                return request.effect === beta.id ? "wait" : "execute";
              },
            });
            return yield* host.operations.run();
          });
          void task.result.catch(() => undefined);
          onTestFinished(() => task.cancel());
          return task.result;
        },
        answer(resolution: { requestId: string; resolutionId: string }) {
          // This tracer supplies the already-prepared transport Outcome; raw UI ingress
          // is exercised by the main chat/provider journey's owned elicitation tool.
          const task = runtime.start(() =>
            journal.interactions.answer(resolution, {
              ok: true,
              value: { ok: true, value: "approved" },
            }),
          );
          onTestFinished(() => task.cancel());
          return task.result;
        },
      };
    }
    return { assemble, store, counts, initial };
  }

  for (const mode of ["success", "authored-failure"] as const) {
    it(`${runtime.name}: catalog loop correlates multi-tool rounds across a parked call and journal reopen (${mode})`, async () => {
      const s = scenario(mode);
      let app = s.assemble();
      const parked = await app.run();
      if (parked.state !== "waiting") {
        throw new Error("Expected parked second tool");
      }
      expect(s.counts).toMatchObject({ samples: 1, alpha: 1, beta: 0 });
      const beforeLoss = await app.read();
      const progressEntries = beforeLoss.entries.filter(
        (entry) => entry.request.effect === progress.id,
      );
      expect(progressEntries.map((entry) => (entry.request.input as ChatLoopEvent).type)).toEqual([
        "assistant",
        "tool-started",
        "tool-completed",
        "tool-started",
      ]);
      const acquiredBeforeRead = s.counts.acquired;
      s.store.reopen();
      app = s.assemble();
      // Reconstruct publication from accepted facts without activating the Guest.
      expect(await app.read()).toEqual(beforeLoss);
      expect(s.counts.acquired).toBe(acquiredBeforeRead);
      expect(s.counts.events).toBe(4);
      expect(await app.run()).toEqual(parked);
      expect(s.counts.events).toBe(4);
      expect(s.counts).toMatchObject({ samples: 1, alpha: 1, beta: 0 });
      await app.answer(parked.grant);
      s.store.reopen();
      app = s.assemble();
      const completed = await app.run();
      if (completed.state !== "completed") {
        throw new Error("Expected completion");
      }
      expect(completed.value.rounds).toBe(3);
      expect(completed.value.history.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "tool",
        "assistant",
        "tool",
        "assistant",
      ]);
      expect(completed.value.history.filter((message) => message.role === "tool")).toEqual([
        {
          role: "tool",
          toolCallId: "a1",
          name: "alpha",
          content: mode === "success" ? "alpha:first" : "Authored refusal",
          isError: mode !== "success",
        },
        { role: "tool", toolCallId: "b1", name: "beta", content: "approved", isError: false },
        {
          role: "tool",
          toolCallId: "a2",
          name: "alpha",
          content: mode === "success" ? "alpha:second" : "Authored refusal",
          isError: mode !== "success",
        },
      ]);
      expect(s.initial).toEqual([{ role: "user", content: "Research" }]);
      expect(s.counts).toMatchObject({ samples: 3, alpha: 2, beta: 0 });
      const published = (await app.read()).entries.filter(
        (entry) => entry.request.effect === progress.id,
      );
      expect(published).toHaveLength(9);
      expect(s.counts.events).toBe(9);
      const completedEvents = published
        .map((entry) => entry.request.input as ChatLoopEvent)
        .filter((event) => event.type === "tool-completed");
      expect(completedEvents.map((event) => [event.call.id, event.isError])).toEqual([
        ["a1", mode !== "success"],
        ["b1", false],
        ["a2", mode !== "success"],
      ]);
      const acquired = s.counts.acquired;
      s.store.reopen();
      expect(await s.assemble().run()).toEqual(completed);
      expect(s.counts.acquired).toBe(acquired);
    });
  }
  for (const [mode, error] of [
    ["unknown", "not in chat catalog"],
    ["duplicate", "tool call identity"],
    ["limit", "round limit reached"],
    ["catalog", "unique nonempty names"],
    ["wrong-model", "selected model"],
  ] as const) {
    it(`${runtime.name}: invalid chat batch/policy fails before tool dispatch (${mode})`, async () => {
      const s = scenario(mode);
      await expect(s.assemble().run()).rejects.toThrow(error);
      expect(s.counts.alpha).toBe(0);
      expect(s.counts.beta).toBe(0);
      expect(s.counts.samples).toBe(mode === "catalog" ? 0 : 1);
    });
  }
  it(`${runtime.name}: a reused call identity cannot dispatch a previously completed tool again`, async () => {
    const s = scenario("reused");
    let app = s.assemble();
    const parked = await app.run();
    if (parked.state !== "waiting") {
      throw new Error("Expected wait");
    }
    await app.answer(parked.grant);
    s.store.reopen();
    app = s.assemble();
    await expect(app.run()).rejects.toThrow("tool call identity");
    expect(s.counts.alpha).toBe(1);
  });
  it(`${runtime.name}: delivery failure stays occupied rather than becoming authored model content`, async () => {
    const s = scenario("delivery-error");
    await expect(s.assemble().run()).rejects.toThrow("Tool transport failed");
    s.store.reopen();
    expect(await s.assemble().run()).toMatchObject({ state: "occupied" });
    expect(s.counts).toMatchObject({ samples: 1, alpha: 1, beta: 0, events: 2 });
    const page = await s.assemble().read();
    expect(
      page.entries
        .filter((entry) => entry.request.effect === progress.id)
        .map((entry) => (entry.request.input as ChatLoopEvent).type),
    ).toEqual(["assistant", "tool-started"]);
  });
  it(`${runtime.name}: failed progress handling cannot advance to tool delivery on reopen`, async () => {
    const s = scenario("progress-error");
    await expect(s.assemble().run()).rejects.toThrow("Progress transport failed");
    expect(s.counts).toMatchObject({ samples: 1, alpha: 0, beta: 0, events: 2 });
    s.store.reopen();
    expect(await s.assemble().run()).toMatchObject({ state: "occupied" });
    expect(s.counts.alpha).toBe(0);
    expect(s.counts.events).toBe(2);
  });

  for (const disposition of ["early-exit", "cancel", "consumer-failure"] as const) {
    it(`${runtime.name}: pull chat owns early termination without advancing an unconsumed tool (${disposition})`, async () => {
      let calls = 0;
      let reader: Subscription<ChatLoopEvent, ChatLoopResult, CapabilityRequest | ScopeInstruction>;
      const guest = createScopedGuest(function* (scope) {
        reader = yield* streamChat(scope, {
          history: [],
          *sample() {
            return {
              ok: true,
              value: {
                model,
                response: response({
                  text: "Ready",
                  calls: [{ id: "a", name: "alpha", input: "input" }],
                }),
              },
            };
          },
          tools: [
            {
              definition: { name: "alpha", description: null, parameters: {} },
              *call() {
                calls++;
                return { content: "done", isError: false };
              },
            },
          ],
        });
        expect((yield* reader.next()).done).toBe(false);
        expect(yield* reader.next()).toMatchObject({
          done: false,
          value: { type: "tool-started" },
        });
        expect(calls).toBe(0);
        if (disposition === "consumer-failure") {
          throw new Error("Consumer failed");
        }
        if (disposition === "cancel") {
          yield* progress.call({
            type: "tool-started",
            round: 0,
            call: { id: "a", name: "alpha", input: "input", thoughtSignature: null },
          });
        }
        return "stopped";
      });
      const task = runtime.start(function* () {
        const turn = yield* guest.start();
        if (disposition === "cancel") {
          expect(turn.kind).toBe("suspended");
          expect(yield* guest.cancel!("stop")).toMatchObject({ kind: "cancelled" });
        } else {
          expect(turn).toEqual({ kind: "completed", value: "stopped" });
        }
      });
      onTestFinished(() => task.cancel());
      if (disposition === "consumer-failure") {
        await expect(task.result).rejects.toThrow("Consumer failed");
      } else {
        await task.result;
      }
      const stale = createScopedGuest(() => reader!.next());
      const probe = runtime.start(() => stale.start());
      onTestFinished(() => probe.cancel());
      await expect(probe.result).rejects.toThrow("scope exited");
      expect(calls).toBe(0);
    });
  }

  it(`${runtime.name}: runChat callback failure stops the shared pull implementation before tools`, async () => {
    let calls = 0;
    const guest = createScopedGuest(function* (scope) {
      return yield* runChat(scope, {
        history: [],
        *sample() {
          return {
            ok: true,
            value: {
              model,
              response: response({
                text: "Ready",
                calls: [{ id: "a", name: "alpha", input: "input" }],
              }),
            },
          };
        },
        tools: [
          {
            definition: { name: "alpha", description: null, parameters: {} },
            *call() {
              calls++;
              return { content: "done", isError: false };
            },
          },
        ],
        *event() {
          throw new Error("Callback failed");
        },
      });
    });
    const task = runtime.start(() => guest.start());
    onTestFinished(() => task.cancel());
    await expect(task.result).rejects.toThrow("Callback failed");
    expect(calls).toBe(0);
  });
  it(`${runtime.name}: accepted round denial survives a larger policy on reopen without provider or tools`, async () => {
    const s = scenario("limit");
    await expect(s.assemble().run()).rejects.toThrow("round limit reached");
    const page = await s.assemble().read();
    expect(page.entries[0]?.outcome).toMatchObject({
      ok: true,
      value: {
        ok: false,
        error: { code: "round-limit", sample: { response: { message: { role: "assistant" } } } },
      },
    });
    s.store.reopen();
    await expect(s.assemble().run(10)).rejects.toThrow("round limit reached");
    expect(s.counts).toMatchObject({ samples: 1, alpha: 0, beta: 0, events: 0 });
  });
});
