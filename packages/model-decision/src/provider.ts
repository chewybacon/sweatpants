import type { Operation } from "effection";
import { definePort } from "@sweatpants/foundation/port";
import {
  DecisionError,
  decisionEffectInputSchema,
  validateDecisionResult,
  type DecisionEffectInput,
  type DecisionResult,
} from "./contract.ts";

export interface DecisionProviderDriver {
  decide(input: DecisionEffectInput, signal: AbortSignal): Operation<DecisionResult>;
}
export const DecisionProviderPort = definePort<DecisionProviderDriver>("decision-provider", {
  *decide() {
    throw new DecisionError("decision_provider_unavailable", "No decision provider is installed");
  },
});

export function installDecisionProvider(driver: DecisionProviderDriver): Operation<void> {
  return DecisionProviderPort.installDriver({
    *decide(input, signal) {
      const checked = decisionEffectInputSchema.parse(input);
      signal.throwIfAborted();
      const result = yield* driver.decide(checked, signal);
      signal.throwIfAborted();
      return validateDecisionResult(checked.request, result);
    },
  });
}
