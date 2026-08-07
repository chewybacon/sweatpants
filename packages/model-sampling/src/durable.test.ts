import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import {
  MODEL_SAMPLE_EFFECT,
  encodeModelSampleResult,
  type ModelSampleEffectCaller,
  sampleDurableModel,
} from "./index.ts";

describe("durable model-sampling authoring helper", () => {
  it("keeps wire encoding and decoding out of authored durable programs", async () => {
    let observedInput: unknown;
    let observedAudience: string | undefined;
    const caller: ModelSampleEffectCaller = {
      *effect(definition, input, resolver): Operation<ReturnType<typeof encodeModelSampleResult>> {
        expect(definition).toBe(MODEL_SAMPLE_EFFECT);
        observedInput = input;
        observedAudience = resolver.audience;
        return encodeModelSampleResult({
          message: {
            message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
            source: null,
            usage: null,
            stopReason: "stop",
            responseId: null,
            errorMessage: null,
          },
          output: { type: "json", value: { answer: 42 } },
        });
      },
    };

    const result = await run(function* () {
      return yield* sampleDurableModel(
        caller,
        {
          invocation: {
            context: { messages: [{ role: "user", content: "question" }], tools: [] },
          },
          tools: { type: "none" },
          response: { type: "json", schema: { type: "object" } },
        },
        { audience: "author:model" },
      );
    });

    expect(observedAudience).toBe("author:model");
    expect(observedInput).toMatchObject({
      invocation: { context: { messages: [{ role: "user", content: "question" }], tools: [] } },
    });
    expect(result).toMatchObject({
      message: { message: { role: "assistant" }, stopReason: "stop" },
      output: { type: "json", value: { answer: 42 } },
    });
  });
});
