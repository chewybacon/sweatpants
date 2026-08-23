import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import { ProgramPlacementContext } from "@sweatpants/durable-effects";
import { effectContractDigest } from "@sweatpants/durable-effects/runtime";
import type { ProgramPlacementContextValue } from "@sweatpants/durable-effects";
import type { ModelContext } from "@sweatpants/model-provider";
import type { Operation } from "effection";
import {
  MODEL_SAMPLE_EFFECT,
  decodeModelSampleSourceRequest,
  encodeModelSampleResult,
  resolveModelSampleSourceRequest,
  type ModelContextSource,
  type ModelSampleDisposition,
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

/**
 * Executes a parked kernel sample pull outside any program scope: decodes the
 * journaled wire request, resolves context sources through the supplied
 * resolver, and invokes the sampling service with an explicit placement.
 * Mirrors createModelSamplingEffectRegistration's handler pipeline so both
 * paths produce identical results for identical requests.
 */
export function* executeModelSamplePull(input: {
  service: ModelSamplingService;
  wireRequest: unknown;
  sessionId: string;
  taskId: string;
  pullId: string;
  attemptId?: string;
  placement: ProgramPlacementContextValue;
  sourceResolver: (source: ModelContextSource) => Operation<ModelContext>;
}): Operation<ModelSampleDisposition> {
  const sourceRequest = decodeModelSampleSourceRequest(input.wireRequest);
  const request = resolveModelSampleSourceRequest(
    sourceRequest,
    yield* input.sourceResolver(sourceRequest.invocation.context),
  );
  return yield* runWithModelSamplingService(input.service, function* () {
    return yield* ModelSamplingApi.operations.sample(request, {
      executor: "host",
      placement: input.placement,
      sessionId: input.sessionId,
      taskId: input.taskId,
      pullId: input.pullId,
      attemptId: input.attemptId ?? `${input.pullId}:engine`,
      effectContractDigest: effectContractDigest(MODEL_SAMPLE_EFFECT),
      cancellation: new AbortController().signal,
    });
  });
}
