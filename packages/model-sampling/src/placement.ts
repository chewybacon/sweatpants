import type { Json } from "@sweatpants/foundation";

export type ModelSampleCaller =
  | "chat-root"
  | "nested-program"
  | "ephemeral-tool-session"
  | "delegated-program";

export interface ModelSamplePlacementFacts {
  readonly caller: ModelSampleCaller;
  readonly hostAvailable: boolean;
  readonly executionAvailable: boolean;
  readonly executionTrusted: boolean;
  readonly requiresOuterDelivery: boolean;
  readonly classifications: readonly Json[];
}

export type ModelSamplePlacementDecision =
  | { readonly executor: "host"; readonly reason: string }
  | { readonly executor: "execution"; readonly reason: string }
  | { readonly executor: "client"; readonly reason: string }
  | { readonly executor: "reject"; readonly code: string; readonly reason: string };

export interface ModelSamplePlacementPolicy {
  decide(facts: ModelSamplePlacementFacts): ModelSamplePlacementDecision;
}

/**
 * Conservative default ownership policy. Execution placement is allowed only
 * for trusted private work; outer live delivery remains Host-owned until a
 * delivery relay is explicitly part of the execution capability.
 */
export const defaultModelSamplePlacementPolicy: ModelSamplePlacementPolicy = Object.freeze({
  decide(facts: ModelSamplePlacementFacts): ModelSamplePlacementDecision {
    if (facts.requiresOuterDelivery) {
      if (facts.hostAvailable) {
        return { executor: "host", reason: "outer delivery is Host-owned" };
      }
      return {
        executor: "reject",
        code: "model_sampling_host_required",
        reason: "outer delivery requires an available Host executor",
      };
    }
    if (facts.caller === "nested-program" && facts.executionAvailable && facts.executionTrusted) {
      return { executor: "execution", reason: "trusted nested execution owns private sampling" };
    }
    if (facts.hostAvailable) {
      return { executor: "host", reason: "Host is the default sampling executor" };
    }
    if (facts.executionAvailable && facts.executionTrusted) {
      return { executor: "execution", reason: "trusted execution is the remaining executor" };
    }
    return {
      executor: "reject",
      code: "model_sampling_placement_unavailable",
      reason: "no authorized model sampling executor is available",
    };
  },
});
