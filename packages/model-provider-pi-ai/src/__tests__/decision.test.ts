import { afterEach, expect, it, vi } from "vitest";
import { run } from "effection";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  DecisionProviderPort,
  installDecisionProvider,
  type DecisionEffectInput,
} from "@sweatpants/model-decision";
import { createPiAiDecisionProvider } from "../decision.ts";

afterEach(() => vi.restoreAllMocks());
const input: DecisionEffectInput = {
  binding: { provider: "opencode", id: "jev-1.13" },
  request: {
    input: "hello",
    question: {
      type: "choice",
      instructions: "Choose intent",
      choices: [
        { value: "continue", description: "Continue" },
        { value: "stop", description: "Stop" },
      ],
    },
  },
};

it("uses the configured classifier collection and restores authored labels in its answer", async () => {
  const models = builtinModels();
  const classify = vi.spyOn(models, "classify").mockResolvedValue({
    api: "typesafe-system-one",
    provider: "opencode",
    model: "jev-1.13",
    timestamp: 1,
    stopReason: "stop",
    answers: {
      decision: {
        type: "choice",
        choice: "option_0",
        confidence: 0.8,
        probabilities: { option_0: 0.9, option_1: 0.1 },
      },
    },
  });
  const signal = new AbortController().signal;
  const result = await run(function* () {
    yield* installDecisionProvider(createPiAiDecisionProvider({ models }));
    return yield* DecisionProviderPort.api.operations.decide(input, signal);
  });
  expect(classify).toHaveBeenCalledWith(
    expect.objectContaining({ type: "classifier", id: "jev-1.13" }),
    {
      state: { input: "hello" },
      questions: {
        decision: {
          type: "choice",
          instructions: "Choose intent",
          criteria: { option_0: "continue: Continue", option_1: "stop: Stop" },
        },
      },
    },
    { signal },
  );
  expect(result.answer).toEqual({
    type: "choice",
    choice: "continue",
    confidence: 0.8,
    probabilities: [
      { value: "continue", probability: 0.9 },
      { value: "stop", probability: 0.1 },
    ],
  });
});

it("fails explicitly on provider errors without publishing provider error text", async () => {
  const models = builtinModels();
  vi.spyOn(models, "classify").mockResolvedValue({
    api: "typesafe-system-one",
    provider: "opencode",
    model: "jev-1.13",
    timestamp: 1,
    stopReason: "error",
    answers: {},
    errorMessage: "private provider diagnostics",
  });
  await expect(
    run(() => createPiAiDecisionProvider({ models }).decide(input, new AbortController().signal)),
  ).rejects.toMatchObject({
    code: "decision_provider_failed",
    message: "Decision provider did not complete the request",
  });
});
