import { call } from "effection";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Models } from "@earendil-works/pi-ai";
import { DecisionError, type DecisionProviderDriver } from "@sweatpants/model-decision";
import { FileCredentialStore } from "./auth.ts";

/** Choice-only adapter. Credentials and transport remain owned by the Pi collection. */
export function createPiAiDecisionProvider(
  options: { models?: Models } = {},
): DecisionProviderDriver {
  const models = options.models ?? builtinModels({ credentials: new FileCredentialStore() });
  return {
    *decide({ binding, request }, signal) {
      const model = models.getModelOfType("classifier", binding.provider, binding.id);
      if (!model) {
        throw new DecisionError(
          "decision_model_unavailable",
          `Unknown decision model: ${binding.provider}/${binding.id}`,
        );
      }
      const choices = request.question.choices;
      // Stable synthetic keys preserve authored option order and avoid JS object-key ordering.
      const criteria = Object.fromEntries(
        choices.map((choice, index) => [
          `option_${index}`,
          `${choice.value}: ${choice.description}`,
        ]),
      );
      const result = yield* call(() =>
        models.classify(
          model,
          {
            state: { input: request.input },
            questions: {
              decision: { type: "choice", instructions: request.question.instructions, criteria },
            },
          },
          { signal },
        ),
      );
      signal.throwIfAborted();
      if (result.stopReason !== "stop") {
        throw new DecisionError(
          "decision_provider_failed",
          "Decision provider did not complete the request",
        );
      }
      const answer = Object.entries(result.answers).find(([key]) => key === "decision")?.[1];
      if (!answer || answer.type !== "choice") {
        throw new DecisionError("decision_response_invalid", "Expected a choice answer");
      }
      const values = new Map(choices.map((choice, index) => [`option_${index}`, choice.value]));
      const selected = values.get(answer.choice);
      if (!selected) {
        throw new DecisionError(
          "decision_response_invalid",
          "Unknown choice returned by decision provider",
        );
      }
      const probabilities = Object.entries(answer.probabilities).map(([key, probability]) => {
        const value = values.get(key);
        if (!value) {
          throw new DecisionError(
            "decision_response_invalid",
            "Unknown option in decision distribution",
          );
        }
        return { value, probability };
      });
      return {
        answer: { type: "choice", choice: selected, confidence: answer.confidence, probabilities },
        model: { provider: result.provider, id: result.model },
        usage: result.usage
          ? { inputTokens: result.usage.input, outputTokens: result.usage.output }
          : null,
      };
    },
  };
}
