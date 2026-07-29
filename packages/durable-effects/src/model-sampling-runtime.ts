import { createContext, type Operation } from "effection";

import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import { createDurableEffectRegistration } from "./authoring.ts";
import { effectContractDigest } from "./runtime.ts";
import type { DurableEffectDisposition } from "./contract.ts";
import {
  MODEL_SAMPLE_EFFECT,
  type ModelSampleCancellationPartial,
  type ModelSampleRequest,
  type ModelSampleResult,
} from "./model-sample-contract.ts";
import {
  ProgramDeliveryWriterContext,
  ProgramPlacementContext,
  type ProgramDeliveryWriter,
  type ProgramPlacementContextValue,
} from "./model-sampling-context.ts";

export {
  ProgramDeliveryWriterContext,
  ProgramPlacementContext,
  type ProgramDeliveryEnvelope,
  type ProgramDeliveryWriter,
  type ProgramPlacementContextValue,
} from "./model-sampling-context.ts";

export class ModelSamplingPlacementError extends Error {
  readonly code = "sampling_placement_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "ModelSamplingPlacementError";
  }
}

export interface ModelSamplingExecutionContext {
  readonly placement: ProgramPlacementContextValue;
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly attemptId: string;
  readonly effectContractDigest: string;
  readonly cancellation: AbortSignal;
  readonly delivery?: ProgramDeliveryWriter;
}

export type ModelSampleDisposition = DurableEffectDisposition<
  ModelSampleResult,
  ModelSampleCancellationPartial
>;

export interface ModelSamplingRouter {
  sample(
    request: ModelSampleRequest,
    context: ModelSamplingExecutionContext,
  ): Operation<ModelSampleDisposition>;
}

export const ModelSamplingRouterContext = createContext<ModelSamplingRouter | undefined>(
  "durable-effects:model-sampling-router",
  undefined,
);

/** Creates the one canonical repeatable model.sample registration. */
export function createModelSamplingEffectRegistration() {
  const definition = MODEL_SAMPLE_EFFECT;
  return createDurableEffectRegistration(
    definition,
    { mode: "repeatable" },
    function* (request, effectContext) {
      const router = yield* ModelSamplingRouterContext.get();
      const placement = yield* ProgramPlacementContext.get();
      const delivery = yield* ProgramDeliveryWriterContext.get();
      if (!router || !placement) {
        throw new ModelSamplingPlacementError(
          "Model sampling router or placement context is unavailable",
        );
      }
      return yield* router.sample(request, {
        placement,
        sessionId: effectContext.sessionId,
        taskId: effectContext.taskId,
        pullId: effectContext.pullId,
        attemptId: effectContext.attemptId,
        effectContractDigest: effectContractDigest(definition),
        cancellation: effectContext.cancellation,
        ...(delivery ? { delivery } : {}),
      });
    },
  );
}

export type ModelSamplingPlacementPolicy =
  | { readonly ownership: "host" }
  | { readonly ownership: "execution"; readonly classifications?: readonly Json[] };

export interface ModelSamplingService {
  sample(
    request: ModelSampleRequest,
    context: ModelSamplingExecutionContext,
  ): Operation<ModelSampleDisposition>;
}

/** Deployment-owned router with an explicit no-fallback execution-local branch. */
export function createModelSamplingRouter(options: {
  readonly policy: (
    placement: ProgramPlacementContextValue,
    request: ModelSampleRequest,
  ) => ModelSamplingPlacementPolicy;
  readonly host: ModelSamplingService;
  readonly execution?: ModelSamplingService;
}): ModelSamplingRouter {
  return Object.freeze({
    *sample(request: ModelSampleRequest, context: ModelSamplingExecutionContext) {
      const policy = options.policy(context.placement, request);
      if (policy.ownership === "host") {
        return yield* options.host.sample(request, context);
      }
      if (!options.execution) {
        throw new ModelSamplingPlacementError(
          "Execution-local model sampling is required but unavailable",
        );
      }
      if (
        policy.classifications &&
        canonicalSnapshot(policy.classifications as Json).sha !==
          canonicalSnapshot((request.classifications ?? []) as Json).sha
      ) {
        throw new ModelSamplingPlacementError(
          "Execution-local model sampling classifications differ",
        );
      }
      return yield* options.execution.sample(request, context);
    },
  });
}
