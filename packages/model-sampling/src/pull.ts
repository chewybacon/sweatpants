import { effectContractDigest } from "@sweatpants/durable-effects/runtime";
import type { ProgramPlacementContextValue } from "@sweatpants/durable-effects";
import type { ModelContext } from "@sweatpants/model-provider";
import type { Operation } from "effection";

import {
  MODEL_SAMPLE_CONTRACT,
  decodeModelSampleSourceRequest,
  resolveModelSampleSourceRequest,
  type ModelContextSource,
  type ModelSampleDisposition,
} from "./contract.ts";
import { ModelSamplingApi, runWithModelSamplingService, type ModelSamplingService } from "./api.ts";

/** Executes one parked sample pull through its selected host or execution service. */
export function* executeModelSamplePull(input: {
  service: ModelSamplingService;
  wireRequest: unknown;
  sessionId: string;
  taskId: string;
  pullId: string;
  attemptId?: string;
  placement: ProgramPlacementContextValue;
  executor?: "host" | "execution";
  cancellation?: AbortSignal;
  sourceResolver: (source: ModelContextSource) => Operation<ModelContext>;
}): Operation<ModelSampleDisposition> {
  const sourceRequest = decodeModelSampleSourceRequest(input.wireRequest);
  const request = resolveModelSampleSourceRequest(
    sourceRequest,
    yield* input.sourceResolver(sourceRequest.invocation.context),
  );
  return yield* runWithModelSamplingService(input.service, function* () {
    return yield* ModelSamplingApi.operations.sample(request, {
      executor: input.executor ?? "host",
      placement: input.placement,
      sessionId: input.sessionId,
      taskId: input.taskId,
      pullId: input.pullId,
      attemptId: input.attemptId ?? `${input.pullId}:engine`,
      effectContractDigest: effectContractDigest(MODEL_SAMPLE_CONTRACT),
      cancellation: input.cancellation ?? new AbortController().signal,
    });
  });
}
