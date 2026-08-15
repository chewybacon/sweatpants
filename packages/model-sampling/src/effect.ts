import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import { ProgramPlacementContext } from "@sweatpants/durable-effects";
import { effectContractDigest } from "@sweatpants/durable-effects/runtime";
import {
  MODEL_SAMPLE_EFFECT,
  decodeModelSampleSourceRequest,
  encodeModelSampleResult,
  resolveModelSampleSourceRequest,
} from "./contract.ts";
import {
  ModelContextSourceResolverContext,
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
    function* (wireRequest, effectContext) {
      const sourceRequest = decodeModelSampleSourceRequest(wireRequest);
      const resolveContext = yield* ModelContextSourceResolverContext.get();
      if (!resolveContext) {
        throw new ModelSamplingUnavailable("Model context source resolver is unavailable");
      }
      const request = resolveModelSampleSourceRequest(
        sourceRequest,
        yield* resolveContext(sourceRequest.invocation.context),
      );
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
      const disposition = service
        ? yield* runWithModelSamplingService(service, function* () {
            return yield* ModelSamplingApi.operations.sample(request, attempt);
          })
        : yield* ModelSamplingApi.operations.sample(request, attempt);
      if (disposition.status === "ok") {
        return { status: "ok", value: encodeModelSampleResult(disposition.value) };
      }
      return disposition;
    },
  );
}
