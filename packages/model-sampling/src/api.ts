import { createContext, type Operation } from "effection";
import { createApi } from "effection/experimental";
import type { ProgramPlacementContextValue } from "@sweatpants/durable-effects";
import type { ModelSampleRequest, ModelSampleDisposition } from "./contract.ts";

export interface ModelSampleAttempt {
  /** Durable routing outcome that selected the current service. */
  readonly executor?: "host" | "execution" | "client";
  readonly placement: ProgramPlacementContextValue;
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly attemptId: string;
  readonly effectContractDigest: string;
  readonly cancellation: AbortSignal;
}

export interface ModelSamplingService {
  sample(
    request: ModelSampleRequest,
    attempt: ModelSampleAttempt,
  ): Operation<ModelSampleDisposition>;
  /** Optional remote-placement cleanup after durable outcome acceptance. */
  acknowledge?(
    attempt: Pick<ModelSampleAttempt, "sessionId" | "taskId" | "pullId">,
    outcomeDigest: string,
  ): Operation<void>;
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

/** Composition-only execution service inherited by the durable execution scope. */
export const ExecutionModelSamplingServiceContext = createContext<ModelSamplingService | undefined>(
  "model-sampling:execution-service",
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
    attempt: ModelSampleAttempt,
  ): Operation<ModelSampleDisposition> {
    const service = yield* ModelSamplingServiceContext.get();
    if (!service) throw new ModelSamplingUnavailable();
    return yield* service.sample(request, attempt);
  },
});

/** Installs one semantic implementation only for the supplied structured scope. */
export function runWithModelSamplingService<T>(
  service: ModelSamplingService | undefined,
  operation: () => Operation<T>,
): Operation<T> {
  return ModelSamplingServiceContext.with(service, operation);
}
