import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { Work } from "@standard-durability/core";
import { createChatContext } from "@sweatpan.ts/chat";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createEffectCapabilities,
  createHosting,
  installEffectAnswers,
} from "@sweatpan.ts/hosting";
import {
  createContextCounter,
  createModelProvider,
  measureContextBudget,
  type ModelInfo,
  type ModelRequest,
} from "@sweatpan.ts/providers";
import { createBufferedSignal, type Runtime } from "@sweatpan.ts/runtime";
import { createHostedRecovery, createSqliteJournalRig, readJournal } from "@sweatpan.ts/testing";
import type { ResolutionGrant } from "@sweatpan.ts/durable";
import { forEachRuntime } from "../runtime/assembly.ts";

const selected: ModelInfo = {
  id: "model",
  provider: "test",
  api: "scripted",
  name: "Model",
  input: ["text"],
  output: ["text"],
  contextWindow: 4096,
  maxOutputTokens: 128,
  reasoningLevels: [],
};
const preparedSchema = z.object({
  model: z.object({ id: z.string(), provider: z.string(), api: z.string() }),
  request: z.object({
    context: z.object({
      messages: z.array(z.object({ role: z.enum(["user", "system"]), content: z.string() })),
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
const modelEffect = defineEffect({
  key: "prepared-model",
  context: z.object({
    question: z.string(),
    target: z.object({ id: z.string(), provider: z.string(), api: z.string() }),
  }),
  response: z.object({
    prepared: preparedSchema,
    count: z.object({ tokens: z.number(), kind: z.enum(["measured", "estimated"]) }),
    response: z.string(),
  }),
});
const proceed = defineEffect({ key: "continue-model", context: z.string(), response: z.boolean() });

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: host-side scoped preparation and counting survive changed policy on journal reopen`, async () => {
    const store = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
      program: "host-preparation",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    let policy = "original";
    let preparations = 0;
    const counted: ModelRequest[] = [];
    const requests: ModelRequest[] = [];
    function start<T>(work: Work<T, Y>) {
      const task = runtime.start(work);
      void task.result.catch(() => undefined);
      onTestFinished(() => task.cancel());
      return task.result;
    }
    function assemble() {
      const journal = store.open();
      const effects = createEffectCapabilities(runtime, "host-preparation-effects");
      const granted = effects.grant({ model: modelEffect, proceed });
      const context = createChatContext(runtime.composition, "model-context");
      const counter = createContextCounter(runtime.composition, "model-counter", {
        *count(_model, request) {
          counted.push(structuredClone(request));
          // A concrete, deliberately labelled serialized-request estimate, not a tokenizer claim.
          return {
            tokens: Math.ceil(JSON.stringify(request).length / 4),
            kind: "estimated" as const,
          };
        },
      });
      const provider = createModelProvider<Y, ModelRequest, never, string>(
        runtime.composition,
        "model-provider",
        {
          *stream(request) {
            requests.push(structuredClone(request));
            const output = createBufferedSignal<never, string, Y>(runtime);
            output.close("answer");
            return yield* output.from(0);
          },
        },
      );
      const recovery = createHostedRecovery<string, CapabilityRequest, Y, unknown, string>(
        runtime,
        {
          name: "host-context-recovery",
          program: "host-preparation",
          matches: isDeepStrictEqual,
          *acquire() {
            return createScopedGuest(function* () {
              const first = yield* granted.capabilities.model({
                question: "first",
                target: { id: selected.id, provider: selected.provider, api: selected.api },
              });
              if (!first.ok) {
                throw new Error("Model failed");
              }
              const next = yield* granted.capabilities.proceed("Continue?");
              if (!next.ok || !next.value) {
                return "Stopped";
              }
              const second = yield* granted.capabilities.model({
                question: `${first.value.response}:next`,
                target: { id: selected.id, provider: selected.provider, api: selected.api },
              });
              if (!second.ok) {
                throw new Error("Model failed");
              }
              return second.value.response;
            });
          },
        },
      );
      const host = createHosting(runtime.composition, {
        name: "host-context",
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
            yield* context.around({
              *prepare([input], next) {
                preparations++;
                return yield* next({
                  ...input,
                  history: [{ role: "system", content: policy }, ...input.history],
                });
              },
            });
            yield* effects.install(modelEffect, function* ({ question, target }) {
              expect(target).toEqual({
                id: selected.id,
                provider: selected.provider,
                api: selected.api,
              });
              // Native APIs run on the Host. The Guest yields only its domain exchange.
              const prepared = yield* context.operations.prepare({
                model: selected,
                history: [{ role: "user", content: question }],
                tools: [{ name: "check", description: "Check", parameters: { type: "object" } }],
              });
              const count = yield* counter.operations.count(selected, prepared.request);
              const budget = measureContextBudget(selected, count, 128);
              if (budget.fits !== true) {
                throw new Error("Context budget exceeded");
              }
              const response = yield* runtime.composition.scoped(function* () {
                const reader = yield* provider.operations.stream(prepared.request);
                const next = yield* reader.next();
                if (!next.done) {
                  throw new Error("Expected terminal result");
                }
                return next.value;
              });
              return {
                ok: true as const,
                value: { prepared: preparedSchema.parse(prepared), count, response },
              };
            });
            yield* host.around(granted.admission);
            yield* host.around({
              *deliveryMode([request], next) {
                if (request.effect === proceed.id) {
                  return "wait" as const;
                }
                return yield* next(request);
              },
            });
            return yield* host.operations.run();
          }),
        answer: (grant: ResolutionGrant) =>
          start(function* () {
            const ingress = yield* installEffectAnswers(host, granted, journal.interactions);
            return yield* ingress.answer(grant, { ok: true, value: true });
          }),
      };
    }
    let app = assemble();
    const parked = await app.run();
    if (parked.state !== "waiting") {
      throw new Error("Expected wait");
    }
    const accepted = (await app.snapshot()).history[0];
    expect(accepted).toMatchObject({
      outcome: {
        ok: true,
        value: {
          ok: true,
          value: {
            prepared: {
              model: { id: "model" },
              request: {
                context: {
                  messages: [
                    { role: "system", content: "original" },
                    { role: "user", content: "first" },
                  ],
                },
              },
            },
            count: { kind: "estimated" },
            response: "answer",
          },
        },
      },
    });
    policy = "changed";
    store.reopen();
    app = assemble();
    await expect(app.run()).resolves.toEqual(parked);
    expect(preparations).toBe(1);
    await app.answer(parked.grant);
    store.reopen();
    app = assemble();
    await expect(app.run()).resolves.toEqual({ state: "completed", value: "answer" });
    expect(preparations).toBe(2);
    expect(counted).toEqual(requests);
    expect(counted).toHaveLength(2);
    expect(counted[1]?.context.messages[0]).toEqual({ role: "system", content: "changed" });
    expect(counted[0]?.context.tools).toHaveLength(1);
    expect((await app.snapshot()).history[0]).toEqual(accepted);
    store.reopen();
    await expect(assemble().run()).resolves.toEqual({ state: "completed", value: "answer" });
    expect(requests).toHaveLength(2);
  });
});
