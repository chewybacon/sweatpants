import { describe, expect, it } from "vitest";
import { run } from "effection";
import {
  DecisionProviderPort,
  installDecisionProvider,
  decisionRequestSchema,
  validateDecisionResult,
  type DecisionRequest,
} from "../index.ts";

const request: DecisionRequest = {
  input: "hello",
  question: {
    type: "choice",
    instructions: "Choose",
    choices: [
      { value: "a", description: "A" },
      { value: "b", description: "B" },
    ],
  },
};
const result = {
  answer: {
    type: "choice" as const,
    choice: "a",
    probabilities: [
      { value: "a", probability: 0.8 },
      { value: "b", probability: 0.2 },
    ],
    confidence: 0.6,
  },
  model: { provider: "test", id: "test" },
  usage: null,
};

describe("decision contract and provider boundary", () => {
  it("preserves the choice distribution, separate confidence, and refusal", () => {
    expect(validateDecisionResult(request, result)).toEqual(result);
    expect(
      validateDecisionResult(request, { ...result, answer: { type: "refusal" } }).answer,
    ).toEqual({ type: "refusal" });
  });
  it.each([
    { ...result.answer, choice: "outside" },
    { ...result.answer, choice: "b" },
    { ...result.answer, confidence: 2 },
    { ...result.answer, probabilities: [{ value: "a", probability: 1 }] },
    {
      ...result.answer,
      probabilities: [
        { value: "a", probability: 0.5 },
        { value: "a", probability: 0.5 },
      ],
    },
    {
      ...result.answer,
      probabilities: [
        { value: "a", probability: 0.8 },
        { value: "b", probability: 0.8 },
      ],
    },
  ])("rejects malformed or request-inconsistent answers %#", (answer) => {
    expect(() => validateDecisionResult(request, { ...result, answer })).toThrow(
      /decision|Decision/,
    );
  });
  it("rejects duplicate choices and excessive input", () => {
    expect(
      decisionRequestSchema.safeParse({
        ...request,
        question: {
          ...request.question,
          choices: [request.question.choices[0], request.question.choices[0]],
        },
      }).success,
    ).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request, input: "x".repeat(32769) }).success).toBe(
      false,
    );
  });
  it("fails closed without a driver", async () => {
    await expect(
      run(() =>
        DecisionProviderPort.api.operations.decide(
          { binding: result.model, request },
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: "decision_provider_unavailable" });
  });
  it("validates substituted drivers and does not start an already cancelled call", async () => {
    let calls = 0;
    await run(function* () {
      yield* installDecisionProvider({
        *decide() {
          calls++;
          return { ...result, answer: { ...result.answer, choice: "outside" } };
        },
      });
      const controller = new AbortController();
      controller.abort();
      try {
        yield* DecisionProviderPort.api.operations.decide(
          { binding: result.model, request },
          controller.signal,
        );
      } catch {
        /* The call below separately verifies the response validation. */
      }
      expect(calls).toBe(0);
      yield* DecisionProviderPort.api.operations.decide(
        { binding: result.model, request },
        new AbortController().signal,
      );
    }).then(
      () => {
        throw new Error("Expected validation failure");
      },
      (error: unknown) => expect(error).toMatchObject({ code: "decision_response_invalid" }),
    );
    expect(calls).toBe(1);
  });
});
