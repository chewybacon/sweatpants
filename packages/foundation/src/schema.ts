import type { StandardSchemaV1 } from "@standard-schema/spec";
import { parser, type Parser } from "./parser.ts";
import { assertJson, canonicalJson, canonicalSnapshot, sha256 } from "./json.ts";
import type { Json } from "./json.ts";
export class SchemaDescriptorError extends Error {
  readonly code = "invalid_schema_descriptor";

  constructor(message: string) {
    super(message);
    this.name = "SchemaDescriptorError";
  }
}

/**
 * Portable schema descriptors are the only schema artifact permitted to cross
 * persistence and transport boundaries. They carry explicit semantic identity
 * plus role-specific JSON Schema projections; they are never the validation
 * authority. Runtime Standard Schema validators are selected separately by
 * digest through a scope-local {@link import("./schema-registry.ts").DurableSchemaRegistry}.
 */

/** Pairs one portable descriptor with its in-process validation authority. */
export interface SchemaBinding<
  D extends PortableSchemaDescriptor<string> = PortableSchemaDescriptor<string>,
> {
  readonly descriptor: D;
  readonly schema: StandardSchemaV1;
}

/** Constructs a minimal Standard Schema V1 wrapper for an in-repo validator. */
export function standardSchemaOf(
  vendor: string,
  validate: (value: unknown) => StandardSchemaV1.Result<unknown>,
): StandardSchemaV1 {
  return { "~standard": { version: 1, vendor, validate } };
}

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
export interface PortableSchemaDescriptor<Role extends string = string> {
  readonly identity: string;
  readonly role: Role;
  readonly version: string;
  readonly vendor: string;
  /** A JSON Schema document; note `true`/`false` are legal schemas. */
  readonly inputProjection: Json;
  readonly outputProjection: Json;
  readonly fidelity: PortableSchemaFidelity;
  readonly digest: string;
}

/** Domain separation for portable schema descriptor digests. */
export const SCHEMA_DESCRIPTOR_DIGEST_DOMAIN = "sweatpants:portable-schema-descriptor:v1";

const MAX_ROLE_LENGTH = 128;

/** Fields committed by {@link computePortableSchemaDigest}. */
export interface PortableSchemaDescriptorFields<Role extends string = string> {
  readonly identity: string;
  readonly role: Role;
  readonly version: string;
  readonly vendor: string;
  readonly inputProjection: Json;
  readonly outputProjection: Json;
  readonly fidelity: PortableSchemaFidelity;
}

/** Computes the domain-separated JCS digest committing to every descriptor field. */
export function computePortableSchemaDigest<Role extends string>(
  fields: PortableSchemaDescriptorFields<Role>,
): string {
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
export function createPortableSchemaDescriptor<Role extends string>(
  fields: PortableSchemaDescriptorFields<Role>,
): PortableSchemaDescriptor<Role>;
export function createPortableSchemaDescriptor(
  fields: PortableSchemaDescriptorFields,
): PortableSchemaDescriptor;
export function createPortableSchemaDescriptor<Role extends string>(
  fields: PortableSchemaDescriptorFields<Role>,
): PortableSchemaDescriptor<Role> {
  requireNonEmpty(fields.identity, "identity");
  requireBoundedRole(fields.role);
  requireNonEmpty(fields.version, "version");
  requireNonEmpty(fields.vendor, "vendor");
  if (!isFidelityValue(fields.fidelity.input) || !isFidelityValue(fields.fidelity.output)) {
    throw invalidDescriptor("fidelity must be lossless or explicit");
  }
  const inputProjection = canonicalSnapshot(assertJson(fields.inputProjection)).value;
  const outputProjection = canonicalSnapshot(assertJson(fields.outputProjection)).value;
  const normalized: PortableSchemaDescriptorFields<Role> = {
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
function parsePortableSchemaDescriptorValue(value: unknown): PortableSchemaDescriptor {
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
    // Owning domains refine the generic role after this structural parse.
    role: value["role"],
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

const portableSchemaDescriptorSchema: StandardSchemaV1<unknown, PortableSchemaDescriptor> = {
  "~standard": {
    version: 1,
    vendor: "sweatpants",
    validate(value) {
      try {
        return { value: parsePortableSchemaDescriptorValue(value) };
      } catch {
        return { issues: [{ path: [], message: "invalid schema descriptor" }] };
      }
    },
  },
};

/** Result-oriented parser for persisted portable schema descriptors. */
export const portableSchemaDescriptorParser: Parser<PortableSchemaDescriptor> = parser(
  portableSchemaDescriptorSchema,
);

/** Caller-owned throwing mapping for descriptor construction and restoration. */
export function parsePortableSchemaDescriptor(value: unknown): PortableSchemaDescriptor {
  const parsed = portableSchemaDescriptorParser.parse(value);
  if (!parsed.ok) {
    throw invalidDescriptor("descriptor shape is invalid");
  }
  return parsed.value;
}

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

function requireBoundedRole(value: string): void {
  requireNonEmpty(value, "role");
  if (value.length > MAX_ROLE_LENGTH) {
    throw invalidDescriptor(`role must be at most ${MAX_ROLE_LENGTH} characters`);
  }
}

function invalidDescriptor(message: string): SchemaDescriptorError {
  return new SchemaDescriptorError(`Invalid schema descriptor: ${message}`);
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
