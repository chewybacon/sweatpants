// @vitest-environment node
import { expect, it } from "vitest";
import { scoped } from "effection";
import {
  installModelProvider,
  ModelProviderModelContext,
  useModel,
  type Model,
  type ModelProviderDriver,
  type ModelProviderSampleRequest,
} from "@sweatpants/model-provider";
import { createChatApp } from "../index.ts";
import { createModelSamplingProvider } from "../model-sampling.ts";

const model: Model = {
  id: "default",
  name: "Default",
  provider: "test",
  api: "test",
  reasoning: false,
  input: ["text"],
  contextWindow: 4096,
  maxTokens: 512,
};

it("shares the application model with sampling, preserves defaults, and isolates child overrides", async () => {
  const calls: ModelProviderSampleRequest[] = [];
  const driver: ModelProviderDriver = {
    *stream() {
      throw new Error("not streaming in this scenario");
    },
    *sample(request) {
      calls.push(request);
      return {
        message: { role: "assistant", content: [{ type: "text", text: request.model.id }] },
        source: null,
        usage: null,
        stopReason: "stop",
        responseId: null,
        errorMessage: null,
      };
    },
  };
  const results: string[] = [];
  const app = createChatApp({
    name: "model-default",
    secret: "model-default-test-secret-at-least-32-bytes",
    storage: { kind: "memory" },
    model: { model, driver, streamOptions: { maxTokens: 123, temperature: 0.4 } },
    setup: {
      application: function* () {
        const sampler = createModelSamplingProvider();
        results.push((yield* sampler.sample([], {})).text);
        yield* scoped(function* () {
          yield* installModelProvider(driver);
          yield* ModelProviderModelContext.set({ ...model, id: "child" });
          results.push((yield* sampler.sample([], { maxTokens: 55 })).text);
        });
        expect((yield* useModel()).id).toBe("default");
        const malformed = yield* sampler.sample([], { schema: { type: "object" } });
        expect(malformed).toMatchObject({ parsed: null, parseError: { rawText: "default" } });
      },
    },
  });
  try {
    await app.inspect();
  } finally {
    await app.close();
  }
  expect(results).toEqual(["default", "child"]);
  expect(calls[0].options).toMatchObject({ maxTokens: 123, temperature: 0.4 });
  expect(calls[1].options).toMatchObject({ maxTokens: 55, temperature: 0.4 });
  expect(calls.every((call) => call.context.tools.length === 0)).toBe(true);
});
