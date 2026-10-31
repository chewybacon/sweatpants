import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { runChat, type ChatLoopResult } from "@sweatpan.ts/chat";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createEffectCapabilities, createHosting } from "@sweatpan.ts/hosting";
import { createHostedRecovery, createSqliteJournalRig } from "@sweatpan.ts/testing";
import type { ChatToolCall, ModelResponse } from "@sweatpan.ts/providers";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

const batch = z.object({
  text: z.string(),
  calls: z.array(z.object({ id: z.string(), name: z.string(), input: z.string() })),
});
const sample = defineEffect({ key: "loop.sample", context: z.number(), response: batch });
const alpha = defineEffect({ key: "loop.alpha", context: z.string(), response: z.string() });
const beta = defineEffect({ key: "loop.beta", context: z.string(), response: z.string() });
const model = { id: "model", provider: "script", api: "script" };
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
      | "unknown"
      | "duplicate"
      | "reused"
      | "limit"
      | "invalid-limit"
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
    const counts = { samples: 0, alpha: 0, beta: 0, acquired: 0 };
    const initial = [{ role: "user" as const, content: "Research" }];
    function assemble() {
      const journal = store.open();
      const effects = createEffectCapabilities(runtime, "loop-effects");
      const grant = effects.grant({ sample, alpha, beta });
      const recovery = createHostedRecovery<ChatLoopResult, CapabilityRequest, Y, unknown, string>(
        runtime,
        {
          name: "loop-recovery",
          program: `loop:${mode}`,
          matches: isDeepStrictEqual,
          *acquire() {
            counts.acquired++;
            return createScopedGuest(function* () {
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
              return yield* runChat({
                history: initial,
                tools: mode === "catalog" ? [tools[0]!, tools[0]!] : tools,
                maxRounds: mode === "invalid-limit" ? 0 : mode === "limit" ? 1 : 4,
                model: () => model,
                *sample(request) {
                  const round = request.history.filter(
                    (message) => message.role === "assistant",
                  ).length;
                  const sampled = yield* grant.capabilities.sample(round);
                  if (!sampled.ok) {
                    throw new Error("Model exchange failed");
                  }
                  return {
                    model: mode === "wrong-model" ? { ...model, id: "other" } : request.model,
                    response: response(sampled.value),
                  };
                },
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
      return {
        run() {
          const task = runtime.start(function* () {
            yield* effects.install(sample, function* (round) {
              counts.samples++;
              if (round === 0) {
                return {
                  ok: true,
                  value: {
                    text: "Working",
                    calls: [
                      { id: "a1", name: "alpha", input: "first" },
                      {
                        id: mode === "duplicate" ? "a1" : "b1",
                        name: mode === "unknown" ? "missing" : "beta",
                        input: "approve",
                      },
                    ],
                  },
                };
              }
              if (round === 1) {
                return {
                  ok: true,
                  value: {
                    text: "More",
                    calls: [
                      { id: mode === "reused" ? "a1" : "a2", name: "alpha", input: "second" },
                    ],
                  },
                };
              }
              return { ok: true, value: { text: "Done", calls: [] } };
            });
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
      s.store.reopen();
      app = s.assemble();
      expect(await app.run()).toEqual(parked);
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
    ["invalid-limit", "Invalid chat round limit"],
    ["catalog", "unique nonempty names"],
    ["wrong-model", "selected model"],
  ] as const) {
    it(`${runtime.name}: invalid chat batch/policy fails before tool dispatch (${mode})`, async () => {
      const s = scenario(mode);
      await expect(s.assemble().run()).rejects.toThrow(error);
      expect(s.counts.alpha).toBe(0);
      expect(s.counts.beta).toBe(0);
      expect(s.counts.samples).toBe(mode === "catalog" || mode === "invalid-limit" ? 0 : 1);
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
    expect(s.counts).toMatchObject({ samples: 1, alpha: 1, beta: 0 });
  });
});
