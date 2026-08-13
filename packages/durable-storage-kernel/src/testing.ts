import { durableKey } from "./codec.ts";
import { DurableCollections } from "./collections.ts";
import type { DurableKernel, DurableMutationOutcome } from "./contract.ts";

/** Shared fixtures for backend conformance suites. */
export const kernelConformanceFixtures = Object.freeze({
  authorityKey: durableKey("conformance-authority"),
  immutableKey: durableKey("conformance-immutable"),
  authorityCollection: DurableCollections.conversationHeads,
  immutableCollection: DurableCollections.conversationCheckpoints,
});

export function isCommitted(
  outcome: DurableMutationOutcome,
): outcome is Extract<DurableMutationOutcome, { status: "committed" }> {
  return outcome.status === "committed";
}

export type DurableKernelFactory = () => Promise<{
  readonly kernel: DurableKernel;
  readonly close: () => Promise<void>;
}>;
