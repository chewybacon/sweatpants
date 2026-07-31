import { createContext, type Operation } from "effection";
import { createApi } from "effection/experimental";
import type { DurableEffectDisposition } from "@sweatpants/durable-effects/contract";
import type { ProgramPlacementContextValue } from "@sweatpants/durable-effects";
import type {
  ModelSampleCancellationPartial,
  ModelSampleRequest,
  ModelSampleResult,
} from "./contract.ts";

export interface ModelSamplingExecutionContext {
  readonly placement: ProgramPlacementContextValue;
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly attemptId: string;
  readonly effectContractDigest: string;
  readonly cancellation: AbortSignal;
}

export type ModelSampleDisposition = DurableEffectDisposition<
  ModelSampleResult,
  ModelSampleCancellationPartial
>;

export interface ModelSamplingService {
  sample(
    request: ModelSampleRequest,
    context: ModelSamplingExecutionContext,
  ): Operation<ModelSampleDisposition>;
}

export class ModelSamplingUnavailable extends Error {
  readonly code = "sampling_placement_unavailable";

  constructor(message = "No model sampling service is installed") {
    super(message);
    this.name = "ModelSamplingUnavailable";
  }
}

const ModelSamplingServiceContext = createContext<ModelSamplingService | undefined>(
  "model-sampling:service",
  undefined,
);

/**
 * Semantic model-sampling API. It has a real scoped implementation rather than
 * a second external driver seam; middleware can surround the complete durable
 * command while ModelProviderPort remains the sole model-I/O port.
 */
export const ModelSamplingApi = createApi("model-sampling", {
  *sample(
    request: ModelSampleRequest,
    context: ModelSamplingExecutionContext,
  ): Operation<ModelSampleDisposition> {
    const service = yield* ModelSamplingServiceContext.get();
    if (!service) throw new ModelSamplingUnavailable();
    return yield* service.sample(request, context);
  },
});

/** Installs one semantic implementation only for the supplied structured scope. */
export function runWithModelSamplingService<T>(
  service: ModelSamplingService | undefined,
  operation: () => Operation<T>,
): Operation<T> {
  return ModelSamplingServiceContext.with(service, operation);
}
