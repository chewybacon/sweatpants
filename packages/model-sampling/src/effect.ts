import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import { ProgramPlacementContext } from "@sweatpants/durable-effects";
import { effectContractDigest } from "@sweatpants/durable-effects/runtime";
import { MODEL_SAMPLE_EFFECT } from "./contract.ts";
import { ModelSamplingApi, ModelSamplingUnavailable } from "./api.ts";

/** Creates the one canonical repeatable model.sample registration. */
export function createModelSamplingEffectRegistration() {
  const definition = MODEL_SAMPLE_EFFECT;
  return createDurableEffectRegistration(
    definition,
    { mode: "repeatable" },
    function* (request, effectContext) {
      const placement = yield* ProgramPlacementContext.get();
      if (!placement) {
        throw new ModelSamplingUnavailable("Model sampling placement context is unavailable");
      }
      return yield* ModelSamplingApi.operations.sample(request, {
        placement,
        sessionId: effectContext.sessionId,
        taskId: effectContext.taskId,
        pullId: effectContext.pullId,
        attemptId: effectContext.attemptId,
        effectContractDigest: effectContractDigest(definition),
        cancellation: effectContext.cancellation,
      });
    },
  );
}
