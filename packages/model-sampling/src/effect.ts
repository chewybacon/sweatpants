import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import { ProgramPlacementContext } from "@sweatpants/durable-effects";
import { effectContractDigest } from "@sweatpants/durable-effects/runtime";
import { MODEL_SAMPLE_EFFECT } from "./contract.ts";
import {
  ModelSamplingApi,
  ModelSamplingUnavailable,
  runWithModelSamplingService,
  type ModelSamplingService,
} from "./api.ts";

/** Creates the one canonical repeatable model.sample registration. */
export function createModelSamplingEffectRegistration(
  service?: ModelSamplingService,
  executor: "host" | "execution" = "host",
) {
  const definition = MODEL_SAMPLE_EFFECT;
  return createDurableEffectRegistration(
    definition,
    { mode: "repeatable" },
    function* (request, effectContext) {
      const placement = yield* ProgramPlacementContext.get();
      if (!placement) {
        throw new ModelSamplingUnavailable("Model sampling placement context is unavailable");
      }
      const attempt = {
        executor,
        placement,
        sessionId: effectContext.sessionId,
        taskId: effectContext.taskId,
        pullId: effectContext.pullId,
        attemptId: effectContext.attemptId,
        effectContractDigest: effectContractDigest(definition),
        cancellation: effectContext.cancellation,
      };
      if (service) {
        return yield* runWithModelSamplingService(service, function* () {
          return yield* ModelSamplingApi.operations.sample(request, attempt);
        });
      }
      return yield* ModelSamplingApi.operations.sample(request, attempt);
    },
  );
}
