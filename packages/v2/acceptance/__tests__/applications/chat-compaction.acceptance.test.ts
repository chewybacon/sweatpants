import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Work } from "@standard-durability/core";
import {
  applyChatCompaction,
  prepareChatCompaction,
  prepareChatInference,
  type ChatCompactionRequest,
  type ChatHistoryMessage,
  type ChatInference,
} from "@sweatpan.ts/chat";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import type { ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createEffectCapabilities,
  createHosting,
  installEffectAnswers,
} from "@sweatpan.ts/hosting";
import type { ModelInfo } from "@sweatpan.ts/providers";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createHostedRecovery, createSqliteJournalRig, readJournal } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

const model: ModelInfo = {
  id: "fixture",
  api: "scripted",
  provider: "test",
  name: "Fixture",
  input: ["text"],
  output: ["text"],
  contextWindow: 8192,
  maxOutputTokens: 1024,
  reasoningLevels: [],
};
const selection = { id: model.id, api: model.api, provider: model.provider };
const history: ChatHistoryMessage[] = [
  { role: "system", content: "Original system instructions" },
  { role: "developer", content: "Original developer instructions" },
  { role: "user", content: "Check the build" },
  {
    role: "assistant",
    model: selection,
    content: [
      {
        type: "tool-call",
        toolCall: { id: "call", name: "build", input: {}, thoughtSignature: null },
      },
    ],
  },
  { role: "tool", toolCallId: "call", name: "build", content: "Passed", isError: false },
  { role: "user", content: "What should we do next?" },
];
const selectionSchema = z.object({ id: z.string(), api: z.string(), provider: z.string() });
const messageSchema = z.union([
  z.object({ role: z.enum(["system", "developer", "user"]), content: z.string() }),
  z.object({
    role: z.literal("assistant"),
    model: selectionSchema,
    content: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({
          type: z.literal("tool-call"),
          toolCall: z.object({
            id: z.string(),
            name: z.string(),
            input: z.json(),
            thoughtSignature: z.string().nullable(),
          }),
        }),
      ]),
    ),
  }),
  z.object({
    role: z.literal("tool"),
    toolCallId: z.string(),
    name: z.string(),
    content: z.string(),
    isError: z.boolean(),
  }),
]);
const compactionSchema: StandardSchemaV1<ChatCompactionRequest> = z.object({
  prefix: z.array(messageSchema),
});
// This tracer's post-compaction context has only instruction/user text messages.
const inferenceSchema: StandardSchemaV1<ChatInference> = z.object({
  model: selectionSchema,
  request: z.object({
    context: z.object({
      messages: z.array(
        z.object({ role: z.enum(["system", "developer", "user"]), content: z.string() }),
      ),
      tools: z.array(
        z.object({
          name: z.string(),
          description: z.string().nullable(),
          parameters: z.record(z.string(), z.json()),
        }),
      ),
    }),
  }),
});
const summarize = defineEffect({
  key: "chat.summarize",
  context: compactionSchema,
  response: z.string().trim().min(1),
});
const resume = defineEffect({ key: "chat.resume", context: z.string(), response: z.boolean() });
const infer = defineEffect({ key: "chat.infer", context: inferenceSchema, response: z.string() });

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task.result;
  }
  for (const mode of ["accepted", "blank", "failure"] as const) {
    it(`${runtime.name}: ${mode} compaction preserves history and only accepted summaries survive reopen`, async () => {
      const store = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
        program: "chat-compaction",
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      let summaries = 0;
      let summaryAvailable = true;
      const inferences: ChatInference[] = [];
      function assemble() {
        const journal = store.open();
        const effects = createEffectCapabilities(runtime, "compaction-effects");
        const granted = effects.grant({ summarize, resume, infer });
        const recovery = createHostedRecovery<string, CapabilityRequest, Y, unknown, string>(
          runtime,
          {
            name: "compaction-recovery",
            program: "chat-compaction",
            matches: isDeepStrictEqual,
            *acquire() {
              return createScopedGuest(function* () {
                const request = prepareChatCompaction(history, 5);
                const answer = yield* granted.capabilities.summarize(request);
                if (!answer.ok) {
                  throw new Error("Summary declined");
                }
                const view = applyChatCompaction(history, request, answer.value);
                const proceed = yield* granted.capabilities.resume("Continue?");
                if (!proceed.ok || !proceed.value) {
                  return "Stopped";
                }
                const result = yield* granted.capabilities.infer(
                  prepareChatInference({ model, history: view, tools: [] }),
                );
                if (!result.ok) {
                  throw new Error("Inference failed");
                }
                return result.value;
              });
            },
          },
        );
        const host = createHosting(runtime.composition, {
          name: "compaction-host",
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          handle: granted.handle,
        });
        return {
          snapshot: () => start(() => readJournal(journal)),
          run: () =>
            start(function* () {
              yield* effects.install(summarize, function* (request) {
                summaries++;
                expect(request.prefix).toEqual(history.slice(0, 5));
                if (!summaryAvailable || mode === "failure") {
                  throw new Error("Summarizer unavailable");
                }
                return {
                  ok: true as const,
                  value: mode === "blank" ? "  " : "  The build passed.  ",
                };
              });
              yield* effects.install(infer, function* (request) {
                inferences.push(structuredClone(request));
                return { ok: true as const, value: "Ship it" };
              });
              yield* host.around(granted.admission);
              yield* host.around({
                *deliveryMode([request], next) {
                  if (request.effect === resume.id) {
                    return "wait" as const;
                  }
                  return yield* next(request);
                },
              });
              return yield* host.operations.run();
            }),
          answer: (grant: ResolutionGrant) =>
            start(function* () {
              const answers = yield* installEffectAnswers(host, granted, journal.interactions);
              return yield* answers.answer(grant, { ok: true, value: true });
            }),
        };
      }
      const original = structuredClone(history);
      let app = assemble();
      if (mode !== "accepted") {
        await expect(app.run()).rejects.toThrow(
          mode === "failure" ? "Summarizer unavailable" : "Effect schema rejected value",
        );
        expect((await app.snapshot()).history).toEqual([]);
        expect(inferences).toEqual([]);
        expect(history).toEqual(original);
        return;
      }
      const parked = await app.run();
      if (parked.state !== "waiting") {
        throw new Error("Expected wait after compaction");
      }
      const before = (await app.snapshot()).history;
      expect(before[0]).toMatchObject({
        request: { input: { prefix: original.slice(0, 5) } },
        outcome: { ok: true, value: { ok: true, value: "The build passed." } },
      });
      summaryAvailable = false;
      store.reopen();
      app = assemble();
      await expect(app.run()).resolves.toEqual(parked);
      expect(summaries).toBe(1);
      await app.answer(parked.grant);
      store.reopen();
      app = assemble();
      await expect(app.run()).resolves.toEqual({ state: "completed", value: "Ship it" });
      expect(inferences).toHaveLength(1);
      expect(inferences[0]?.request.context.messages).toEqual([
        original[0],
        original[1],
        { role: "user", content: "Summary of earlier conversation:\nThe build passed." },
        original[5],
      ]);
      expect((await app.snapshot()).history[0]).toEqual(before[0]);
      expect(history).toEqual(original);
      store.reopen();
      await expect(assemble().run()).resolves.toEqual({ state: "completed", value: "Ship it" });
      expect(summaries).toBe(1);
      expect(inferences).toHaveLength(1);
    });
  }

  it(`${runtime.name}: compaction rejects split groups and changed prefixes before downstream work`, async () => {
    let dispatched = 0;
    const api = runtime.composition.createApi("compacted-inference", {
      *run(source: readonly ChatHistoryMessage[], request: ChatCompactionRequest, summary: string) {
        const view = applyChatCompaction(source, request, summary);
        const inference = prepareChatInference({ model, history: view, tools: [] });
        dispatched++;
        return inference;
      },
    });
    const request = prepareChatCompaction(history, 5);
    for (const boundary of [0, 2, 4, 7, 2.5]) {
      await expect(
        start(function* () {
          const invalid = prepareChatCompaction(history, boundary);
          return yield* api.operations.run(history, invalid, "Summary");
        }),
      ).rejects.toThrow();
    }
    const changed = structuredClone(history);
    changed[2] = { role: "user", content: "Different branch" };
    await expect(start(() => api.operations.run(changed, request, "Summary"))).rejects.toThrow(
      "prefix does not match",
    );
    await expect(start(() => api.operations.run(history, request, "  "))).rejects.toThrow(
      "must not be blank",
    );
    expect(dispatched).toBe(0);
    const appended: ChatHistoryMessage[] = [
      ...history,
      { role: "user", content: "Also check release notes" },
    ];
    const prepared = await start(() => api.operations.run(appended, request, "Build passed"));
    expect(prepared.request.context.messages.at(-1)).toEqual(appended.at(-1));
    expect(request.prefix).toEqual(history.slice(0, 5));
    // A subsequent compaction explicitly anchors the already-compacted view.
    const view = applyChatCompaction(appended, request, "Build passed");
    const next = prepareChatCompaction(view, view.length - 1);
    const twice = await start(() =>
      api.operations.run(view, next, "Build passed; release pending"),
    );
    expect(twice.request.context.messages).toHaveLength(4);
    expect(twice.request.context.messages.slice(0, 2)).toEqual(history.slice(0, 2));
  });
});
