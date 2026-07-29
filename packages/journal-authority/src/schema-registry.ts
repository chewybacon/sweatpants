import { CrankError } from "@sweatpants/durable-execution";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation } from "effection";

import { assertJson, canonicalSnapshot, type Json } from "@sweatpants/foundation";
import {
  safeSchemaIssues,
  validateStandardSchema,
  type SafeSchemaIssue,
} from "@sweatpants/foundation/schema-validation";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  NULL_RESULT_SCHEMA_DESCRIPTOR,
  parsePortableSchemaDescriptor,
  standardSchemaOf,
  type PortableSchemaDescriptor,
  type SchemaBinding,
} from "@sweatpants/foundation/schema-descriptor";

/**
 * Scope-local runtime validator registry keyed by portable schema digest.
 *
 * Runtime Standard Schema objects contain functions and MUST never enter
 * persisted manifests, authority snapshots, capability claims, public events,
 * or worker messages; they are always re-selected from this registry by the
 * exact digest bound at authoring time.
 */

/** One digest-addressable validator paired with its portable descriptor. */
/**
 * Versioned validator-bundle catalog published alongside each exact
 * program/effect bundle. Catalogs from concurrent releases are merged into one
 * digest-keyed registry at deployment composition.
 */
export interface DurableSchemaCatalog {
  readonly name: string;
  readonly version: string;
  readonly entries: readonly SchemaBinding[];
}

/** Digest-keyed scope-local registry of runtime Standard Schema validators. */
export interface DurableSchemaRegistry {
  get(digest: string): SchemaBinding | undefined;
  has(digest: string): boolean;
  descriptors(): readonly PortableSchemaDescriptor[];
  /** Returns digests referenced by callers that this registry cannot satisfy. */
  missing(required: Iterable<string>): string[];
}

/** Closed registry validation result algebra. */
export type RegistrySchemaValidation =
  | { status: "ok"; value: Json }
  | { status: "invalid"; issues: SafeSchemaIssue[] }
  | { status: "unavailable"; digest: string };

/** Creates a versioned validator catalog after descriptor boundary validation. */
export function createDurableSchemaCatalog(
  name: string,
  version: string,
  entries: readonly SchemaBinding[],
): DurableSchemaCatalog {
  if (!name || !version) {
    throw new CrankError("invalid_schema_catalog", "Catalog name and version are required");
  }
  return Object.freeze({
    name,
    version,
    entries: Object.freeze(entries.map(normalizeEntry)),
  });
}

/** Creates a digest-keyed registry from entries; built-ins are always present. */
export function createDurableSchemaRegistry(
  entries: readonly SchemaBinding[] = [],
): DurableSchemaRegistry {
  const byDigest = new Map<string, SchemaBinding>();
  for (const builtin of builtinEntries()) {
    byDigest.set(builtin.descriptor.digest, builtin);
  }
  for (const entry of entries) {
    addEntry(byDigest, normalizeEntry(entry));
  }
  return registryOver(byDigest);
}

/**
 * Merges current plus retained historical catalogs into one registry.
 * Concurrent versions of the same identity coexist under distinct digests.
 */
export function createDurableSchemaRegistryFromCatalogs(
  catalogs: readonly DurableSchemaCatalog[],
): DurableSchemaRegistry {
  return createDurableSchemaRegistry(catalogs.flatMap((catalog) => [...catalog.entries]));
}

/**
 * Task-inventory reconciliation used by deployment readiness and bundle
 * retirement: readiness MUST fail while any nonterminal task references a
 * digest absent from the merged registry.
 */
export function reconcileSchemaCoverage(
  registry: DurableSchemaRegistry,
  requiredDigests: Iterable<string>,
): { complete: boolean; missing: string[] } {
  const missing = registry.missing(requiredDigests);
  return { complete: missing.length === 0, missing };
}

/**
 * Validates a value against the exact registered validator for `digest`,
 * canonicalizing successful output as bounded `Json`. Missing digests report
 * `unavailable` so callers can reject with `schema_version_unavailable`.
 */
export function* validateRegisteredSchema(
  registry: DurableSchemaRegistry,
  digest: string,
  value: unknown,
): Operation<RegistrySchemaValidation> {
  const entry = registry.get(digest);
  if (!entry) {
    return { status: "unavailable", digest };
  }
  let result: StandardSchemaV1.Result<unknown>;
  try {
    result = yield* validateStandardSchema(entry.schema, value);
  } catch {
    // Thrown validator values may contain secrets or runtime internals; only a
    // bounded synthetic issue is reported.
    return { status: "invalid", issues: [{ message: "schema validation threw" }] };
  }
  if (result.issues) {
    return { status: "invalid", issues: safeSchemaIssues(result.issues) };
  }
  try {
    return { status: "ok", value: canonicalSnapshot(assertJson(result.value)).value };
  } catch {
    return {
      status: "invalid",
      issues: [{ message: "validated value is not bounded canonical JSON" }],
    };
  }
}

function builtinEntries(): SchemaBinding[] {
  return [
    {
      descriptor: NULL_RESULT_SCHEMA_DESCRIPTOR,
      schema: standardSchemaOf("sweatpants", (value) =>
        value === null ? { value: null } : { issues: [{ message: "value must be null" }] },
      ),
    },
    {
      descriptor: ANY_JSON_SCHEMA_DESCRIPTOR,
      schema: standardSchemaOf("sweatpants", (value) => {
        try {
          return { value: assertJson(value) };
        } catch {
          return { issues: [{ message: "value must be canonical JSON" }] };
        }
      }),
    },
  ];
}

function normalizeEntry(entry: SchemaBinding): SchemaBinding {
  const descriptor = parsePortableSchemaDescriptor(entry.descriptor);
  const standard = entry.schema?.["~standard"];
  if (!standard || standard.version !== 1 || typeof standard.validate !== "function") {
    throw new CrankError(
      "invalid_schema_catalog",
      `Registry entry ${descriptor.identity} lacks a Standard Schema V1 validator`,
    );
  }
  return { descriptor, schema: entry.schema };
}

function addEntry(byDigest: Map<string, SchemaBinding>, entry: SchemaBinding): void {
  const existing = byDigest.get(entry.descriptor.digest);
  if (existing) {
    // Digest commits to identity/role/version/vendor/projections, so a digest
    // collision with different fields is cryptographically implausible; the
    // duplicate registration is idempotent.
    return;
  }
  byDigest.set(entry.descriptor.digest, entry);
}

function registryOver(byDigest: Map<string, SchemaBinding>): DurableSchemaRegistry {
  return {
    get: (digest) => byDigest.get(digest),
    has: (digest) => byDigest.has(digest),
    descriptors: () => [...byDigest.values()].map((entry) => entry.descriptor),
    missing: (required) => {
      const missing: string[] = [];
      const seen = new Set<string>();
      for (const digest of required) {
        if (!byDigest.has(digest) && !seen.has(digest)) {
          seen.add(digest);
          missing.push(digest);
        }
      }
      return missing;
    },
  };
}
