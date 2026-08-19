import { assertJson, canonicalJson, sha256, type Json } from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";

export const INTERACTION_BINDING_DOMAIN = "sweatpants.interaction-binding.v1\n";

/** Stable content address of one authored interaction contract. */
export interface InteractionBinding {
  readonly id: string;
}

/** Complete compiler input for one authored elicitation. */
export interface ElicitBindingEvidence {
  readonly ownerInterfaceDigest: string;
  readonly kind: "elicit";
  readonly key: string;
  readonly response: PortableSchemaDescriptor;
  readonly context: PortableSchemaDescriptor | null;
  readonly metadata: Json;
}

export interface ToolInteractionBindings {
  readonly elicits: Readonly<Record<string, InteractionBinding>>;
}

/** Compile one interaction binding from validated authored evidence. */
export function compileInteractionBinding(evidence: ElicitBindingEvidence): InteractionBinding {
  const canonical = canonicalJson({
    ownerInterfaceDigest: evidence.ownerInterfaceDigest,
    kind: evidence.kind,
    key: evidence.key,
    response: evidence.response,
    context: evidence.context,
    metadata: assertJson(evidence.metadata),
  });
  return Object.freeze({ id: sha256(`${INTERACTION_BINDING_DOMAIN}${canonical}`) });
}

/** Compile the complete elicit binding table for one normalized tool contract. */
export function compileToolInteractionBindings(input: {
  readonly ownerInterfaceDigest: string;
  readonly elicits: Readonly<
    Record<string, { readonly metadata?: Readonly<Record<string, unknown>> }>
  >;
  readonly artifacts: Readonly<
    Record<
      string,
      {
        readonly response: PortableSchemaDescriptor;
        readonly context?: PortableSchemaDescriptor;
      }
    >
  >;
}): ToolInteractionBindings {
  const bindings: Record<string, InteractionBinding> = {};
  for (const [key, definition] of Object.entries(input.elicits)) {
    const artifact = input.artifacts[key];
    if (!artifact) {
      throw new Error(`No schema artifact exists for authored elicitation "${key}"`);
    }
    bindings[key] = compileInteractionBinding({
      ownerInterfaceDigest: input.ownerInterfaceDigest,
      kind: "elicit",
      key,
      response: artifact.response,
      context: artifact.context ?? null,
      metadata: assertJson(definition.metadata ?? null),
    });
  }
  for (const key of Object.keys(input.artifacts)) {
    if (!(key in input.elicits)) {
      throw new Error(`Schema artifact exists for undeclared elicitation "${key}"`);
    }
  }
  return Object.freeze({ elicits: Object.freeze(bindings) });
}

/** Strict structural decoder. It validates syntax, not provenance. */
export function parseInteractionBinding(value: unknown): InteractionBinding {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.id)
  ) {
    throw new Error("Interaction binding must be an exact object with one lowercase SHA-256 id");
  }
  return Object.freeze({ id: value.id });
}
