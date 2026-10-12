import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import { DecisionProviderPort } from "./provider.ts";
import {
  MODEL_DECISION_EFFECT,
  decisionEffectInputSchema,
  decisionResultSchema,
  validateDecisionResult,
} from "./contract.ts";

/** Runs at the host effect boundary; accepted results are replayed by the journal. */
export function createDecisionEffectRegistration() {
  return createDurableEffectRegistration(
    MODEL_DECISION_EFFECT,
    { mode: "repeatable" },
    function* (input, context) {
      const checked = decisionEffectInputSchema.parse(input);
      const result = yield* DecisionProviderPort.api.operations.decide(
        checked,
        context.cancellation,
      );
      return { status: "ok", value: validateDecisionResult(checked.request, result) };
    },
    { input: decisionEffectInputSchema, output: decisionResultSchema },
  );
}
