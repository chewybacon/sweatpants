import type { Operation } from "effection";
import type {
  DurableEffectAuthorization,
  EffectDefinition,
  OperationOutcome,
  ProgramPlacementContextValue,
} from "@sweatpants/durable-effects";
import type { AttachProgramRequest } from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";

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
