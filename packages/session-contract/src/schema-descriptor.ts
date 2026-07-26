import type { StandardSchemaV1 } from "@standard-schema/spec";
import { assertJson, canonicalJson, canonicalSnapshot, sha256 } from "./canonical.ts";
import { CrankError, type Json } from "./types.ts";

/**
 * Portable schema descriptors are the only schema artifact permitted to cross
 * persistence and transport boundaries. They carry explicit semantic identity
 * plus role-specific JSON Schema projections; they are never the validation
 * authority. Runtime Standard Schema validators are selected separately by
 * digest through a scope-local {@link import("./schema-registry.ts").DurableSchemaRegistry}.
 */

/** Closed role algebra binding a schema descriptor to its acceptance boundary. */
export type PortableSchemaRole =
  | "tool_parameters"
  | "tool_output"
  | "program_input"
  | "program_output"
  | "effect_input"
  | "effect_output"
  | "effect_cancellation_partial"
  | "elicit_response"
  | "elicit_context"
  | "builtin";

/**
 * Projection fidelity per role:
 * - `lossless`: generated directly from the authoring validator.
 * - `explicit`: supplied by the author because generation is unrepresentable.
 */
export interface PortableSchemaFidelity {
  readonly input: "lossless" | "explicit";
  readonly output: "lossless" | "explicit";
}

/**
 * Canonical serializable schema identity, role, versioning, and role-specific
 * draft-2020-12 JSON Schema projections. `digest` commits to every other field
 * under a domain-separated SHA-256 of the JCS canonical form.
 */
export interface PortableSchemaDescriptor {
  readonly identity: string;
  readonly role: PortableSchemaRole;
  readonly version: string;
  readonly vendor: string;
  readonly inputProjection: Json;
  readonly outputProjection: Json;
  readonly fidelity: PortableSchemaFidelity;
  readonly digest: string;
}

/** Domain separation for portable schema descriptor digests. */
export const SCHEMA_DESCRIPTOR_DIGEST_DOMAIN = "sweatpants:portable-schema-descriptor:v1";

const ROLES: readonly PortableSchemaRole[] = [
  "tool_parameters",
  "tool_output",
  "program_input",
  "program_output",
  "effect_input",
  "effect_output",
  "effect_cancellation_partial",
  "elicit_response",
  "elicit_context",
  "builtin",
];

/** Fields committed by {@link computePortableSchemaDigest}. */
export interface PortableSchemaDescriptorFields {
  readonly identity: string;
  readonly role: PortableSchemaRole;
  readonly version: string;
  readonly vendor: string;
  readonly inputProjection: Json;
  readonly outputProjection: Json;
  readonly fidelity: PortableSchemaFidelity;
}

/** Computes the domain-separated JCS digest committing to every descriptor field. */
export function computePortableSchemaDigest(fields: PortableSchemaDescriptorFields): string {
  const canonical = canonicalJson({
    identity: fields.identity,
    role: fields.role,
    version: fields.version,
    vendor: fields.vendor,
    inputProjection: fields.inputProjection,
    outputProjection: fields.outputProjection,
    fidelity: { input: fields.fidelity.input, output: fields.fidelity.output },
  });
  return sha256(`${SCHEMA_DESCRIPTOR_DIGEST_DOMAIN}\n${canonical}`);
}

/** Validates, canonicalizes, digests, and freezes one portable schema descriptor. */
export function createPortableSchemaDescriptor(
  fields: PortableSchemaDescriptorFields,
): PortableSchemaDescriptor {
  requireNonEmpty(fields.identity, "identity");
  requireNonEmpty(fields.version, "version");
  requireNonEmpty(fields.vendor, "vendor");
  if (!ROLES.includes(fields.role)) {
    throw invalidDescriptor(`unknown role ${String(fields.role)}`);
  }
  if (!isFidelityValue(fields.fidelity.input) || !isFidelityValue(fields.fidelity.output)) {
    throw invalidDescriptor("fidelity must be lossless or explicit");
  }
  const inputProjection = canonicalSnapshot(assertJson(fields.inputProjection)).value;
  const outputProjection = canonicalSnapshot(assertJson(fields.outputProjection)).value;
  const normalized: PortableSchemaDescriptorFields = {
    identity: fields.identity,
    role: fields.role,
    version: fields.version,
    vendor: fields.vendor,
    inputProjection,
    outputProjection,
    fidelity: { input: fields.fidelity.input, output: fields.fidelity.output },
  };
  return deepFreeze({
    ...normalized,
    digest: computePortableSchemaDigest(normalized),
  });
}

/**
 * Boundary parser for persisted descriptors. Rejects structural drift and any
 * digest that does not recommit to the descriptor's own fields.
 */
export function parsePortableSchemaDescriptor(value: unknown): PortableSchemaDescriptor {
  if (!isRecord(value)) {
    throw invalidDescriptor("descriptor must be an object");
  }
  const keys = Object.keys(value);
  const allowed = [
    "identity",
    "role",
    "version",
    "vendor",
    "inputProjection",
    "outputProjection",
    "fidelity",
    "digest",
  ];
  if (keys.length !== allowed.length || !allowed.every((key) => key in value)) {
    throw invalidDescriptor("descriptor has unexpected keys");
  }
  const fidelity = value["fidelity"];
  if (
    typeof value["identity"] !== "string" ||
    typeof value["role"] !== "string" ||
    typeof value["version"] !== "string" ||
    typeof value["vendor"] !== "string" ||
    typeof value["digest"] !== "string" ||
    !isRecord(fidelity) ||
    !isFidelityValue(fidelity["input"]) ||
    !isFidelityValue(fidelity["output"])
  ) {
    throw invalidDescriptor("descriptor field types are invalid");
  }
  const descriptor = createPortableSchemaDescriptor({
    identity: value["identity"],
    role: value["role"] as PortableSchemaRole,
    version: value["version"],
    vendor: value["vendor"],
    inputProjection: assertJson(value["inputProjection"]),
    outputProjection: assertJson(value["outputProjection"]),
    fidelity: { input: fidelity["input"], output: fidelity["output"] },
  });
  if (descriptor.digest !== value["digest"]) {
    throw invalidDescriptor("descriptor digest does not commit to its fields");
  }
  return descriptor;
}

/** Built-in descriptor for scheduler wait results (`null`). */
export const NULL_RESULT_SCHEMA_DESCRIPTOR: PortableSchemaDescriptor =
  createPortableSchemaDescriptor({
    identity: "sweatpants/builtin/null-result",
    role: "builtin",
    version: "1",
    vendor: "sweatpants",
    inputProjection: { type: "null" },
    outputProjection: { type: "null" },
    fidelity: { input: "lossless", output: "lossless" },
  });

/** Built-in descriptor for structured-child results (any bounded canonical JSON). */
export const ANY_JSON_SCHEMA_DESCRIPTOR: PortableSchemaDescriptor = createPortableSchemaDescriptor({
  identity: "sweatpants/builtin/any-json",
  role: "builtin",
  version: "1",
  vendor: "sweatpants",
  inputProjection: true,
  outputProjection: true,
  fidelity: { input: "lossless", output: "lossless" },
});

function isFidelityValue(value: unknown): value is "lossless" | "explicit" {
  return value === "lossless" || value === "explicit";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidDescriptor(`${field} must be non-empty`);
  }
}

function invalidDescriptor(message: string): CrankError {
  return new CrankError("invalid_schema_descriptor", `Invalid schema descriptor: ${message}`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

/**
 * One descriptor paired with the validator that enforces it.
 *
 * Declared here rather than in `schema-registry.ts` so that contract modules
 * can describe their own entries without depending on the registry that
 * consumes them.
 */
export interface DurableSchemaRegistryEntry {
  readonly descriptor: PortableSchemaDescriptor;
  readonly schema: StandardSchemaV1;
}
