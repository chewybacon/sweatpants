import type { Operation } from "effection";
import type {
  DurableEffectAuthorization,
  EffectDefinition,
  OperationOutcome,
  ProgramPlacementContextValue,
} from "@sweatpants/durable-effects";
import type { AttachProgramRequest } from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";

/** Explicit signal that post-commit acknowledgement may be retried without failing the turn. */
export class RetryableEffectAcknowledgement extends Error {
  readonly code = "retryable_effect_acknowledgement";

  constructor(message = "Effect acknowledgement can be retried") {
    super(message);
    this.name = "RetryableEffectAcknowledgement";
  }
}

/** Routes and performs an installed effect after Authority authorization. */
export interface EffectRouter {
  route(request: {
    readonly authorization: DurableEffectAuthorization;
    readonly definition: EffectDefinition<Json, Json, Json>;
    readonly placement: ProgramPlacementContextValue;
  }): Operation<"host" | "execution">;
  executeHost(
    authorization: DurableEffectAuthorization,
    placement: ProgramPlacementContextValue,
  ): Operation<OperationOutcome>;
  acknowledge?(request: {
    readonly authorization: DurableEffectAuthorization;
    readonly outcome: OperationOutcome;
  }): Operation<void>;
}

/** Journal-owned sampling preparation boundary. */
export type JournalSamplingService = (input: Json, attach: AttachProgramRequest) => Operation<Json>;

export interface AdvancementServices {
  readonly effects?: EffectRouter;
  readonly stageSampleInput?: JournalSamplingService;
}
