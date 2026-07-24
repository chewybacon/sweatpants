import type { Operation } from "effection";
import { createApi } from "effection/experimental";

import type { EffectDefinition, PinnedProgram, ProgramRoute } from "./durable-types.ts";
import type { Json } from "./types.ts";

export type DurableEffectRoute =
  | { readonly placement: "host" }
  | { readonly placement: "execution" };

export interface DurableEffectRoutingRequest {
  readonly definition: EffectDefinition<Json, Json, Json>;
  readonly effectContractDigest: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly attemptId: string;
  readonly program: PinnedProgram;
  readonly programRoute: ProgramRoute;
}

/** Host-default, scope-middleware-aware route selection for unresolved installed effects. */
export const DurableEffectRouting = createApi<{
  route(request: DurableEffectRoutingRequest): Operation<DurableEffectRoute>;
}>("crank-durable-effect-routing", {
  *route() {
    return { placement: "host" };
  },
});
