import { canonicalSnapshot } from "./canonical.ts";
import type { EffectDefinition } from "./durable-types.ts";
import type { Json } from "./types.ts";

/** Versioned canonical document used to compare complete durable effect contracts. */
export interface EffectContractDigestDocumentV1 {
  kind: "sweatpants.effect-contract";
  digestVersion: 1;
  name: string;
  version: string;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  cancellationPartialSchemaDigest: string | null;
  retrySafety: EffectDefinition["retrySafety"];
}

/**
 * Computes compatibility identity for every normative field of an effect contract.
 * This derived digest is deliberately not stored in pinned manifests.
 */
export function effectContractDigest(definition: EffectDefinition<Json, Json, Json>): string {
  const document: EffectContractDigestDocumentV1 = {
    kind: "sweatpants.effect-contract",
    digestVersion: 1,
    name: definition.name,
    version: definition.version,
    inputSchemaDigest: definition.inputSchema.digest,
    outputSchemaDigest: definition.outputSchema.digest,
    cancellationPartialSchemaDigest: definition.cancellation?.partialSchema.digest ?? null,
    retrySafety: definition.retrySafety,
  };
  return canonicalSnapshot(document).sha;
}
