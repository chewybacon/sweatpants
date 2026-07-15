import type { StandardSchemaV1 } from "@standard-schema/spec";
import { call, type Operation } from "effection";

import { assertJson, canonicalSnapshot } from "./canonical.ts";
import { foreignToolSchemaEntries } from "./foreign-tool-contract.ts";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  NULL_RESULT_SCHEMA_DESCRIPTOR,
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "./schema-descriptor.ts";
import { CrankError, type Json } from "./types.ts";

/**
 * Scope-local runtime validator registry keyed by portable schema digest.
 *
 * Runtime Standard Schema objects contain functions and MUST never enter
 * persisted manifests, authority snapshots, capability claims, public events,
 * or worker messages; they are always re-selected from this registry by the
 * exact digest bound at authoring time.
 */

/** One digest-addressable validator paired with its portable descriptor. */
export interface DurableSchemaRegistryEntry {
  readonly descriptor: PortableSchemaDescriptor;
  readonly schema: StandardSchemaV1;
}

/**
 * Versioned validator-bundle catalog published alongside each exact
 * program/effect bundle. Catalogs from concurrent releases are merged into one
 * digest-keyed registry at deployment composition.
 */
export interface DurableSchemaCatalog {
  readonly name: string;
  readonly version: string;
  readonly entries: readonly DurableSchemaRegistryEntry[];
}

/** Digest-keyed scope-local registry of runtime Standard Schema validators. */
export interface DurableSchemaRegistry {
  get(digest: string): DurableSchemaRegistryEntry | undefined;
  has(digest: string): boolean;
  descriptors(): readonly PortableSchemaDescriptor[];
  /** Returns digests referenced by callers that this registry cannot satisfy. */
  missing(required: Iterable<string>): string[];
}

/** Bounded, redacted validation issue safe for journals and public errors. */
export interface SafeSchemaIssue {
  readonly message: string;
  readonly path?: string;
}

/** Closed registry validation result algebra. */
export type RegistrySchemaValidation =
  | { status: "ok"; value: Json }
  | { status: "invalid"; issues: SafeSchemaIssue[] }
  | { status: "unavailable"; digest: string };

const MAX_ISSUES = 16;
const MAX_ISSUE_MESSAGE_LENGTH = 512;
const MAX_ISSUE_PATH_LENGTH = 256;

/** Creates a versioned validator catalog after descriptor boundary validation. */
export function createDurableSchemaCatalog(
  name: string,
  version: string,
  entries: readonly DurableSchemaRegistryEntry[],
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
  entries: readonly DurableSchemaRegistryEntry[] = [],
): DurableSchemaRegistry {
  const byDigest = new Map<string, DurableSchemaRegistryEntry>();
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
 * Runs one Standard Schema validation through Effection. Promise-returning
 * validators are awaited as an Operation; raw Promises never become runtime
 * handler contracts.
 */
export function* validateStandardSchema(
  schema: StandardSchemaV1,
  value: unknown,
): Operation<StandardSchemaV1.Result<unknown>> {
  const result = schema["~standard"].validate(value);
  if (isPromiseLike(result)) {
    return yield* call(() => Promise.resolve(result));
  }
  return result;
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

/** Projects Standard Schema issues into bounded, redacted diagnostics. */
export function safeSchemaIssues(
  issues: readonly StandardSchemaV1.Issue[],
): SafeSchemaIssue[] {
  return issues.slice(0, MAX_ISSUES).map((issue) => {
    const message =
      typeof issue.message === "string"
        ? issue.message.slice(0, MAX_ISSUE_MESSAGE_LENGTH)
        : "invalid value";
    const path = issuePath(issue.path);
    return path === undefined ? { message } : { message, path };
  });
}

function issuePath(
  path: StandardSchemaV1.Issue["path"],
): string | undefined {
  if (!path || path.length === 0) {
    return undefined;
  }
  const rendered = path
    .map((segment) => {
      const key =
        typeof segment === "object" && segment !== null && "key" in segment
          ? segment.key
          : segment;
      return typeof key === "symbol" ? "<symbol>" : String(key);
    })
    .join(".");
  return rendered.slice(0, MAX_ISSUE_PATH_LENGTH);
}

function builtinEntries(): DurableSchemaRegistryEntry[] {
  return [
    ...foreignToolSchemaEntries(),
    {
      descriptor: NULL_RESULT_SCHEMA_DESCRIPTOR,
      schema: standardSchemaOf("sweatpants", (value) =>
        value === null
          ? { value: null }
          : { issues: [{ message: "value must be null" }] },
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

/** Constructs a minimal in-repo Standard Schema wrapper for built-in validators. */
export function standardSchemaOf(
  vendor: string,
  validate: (value: unknown) => StandardSchemaV1.Result<unknown>,
): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate,
    },
  };
}

function normalizeEntry(entry: DurableSchemaRegistryEntry): DurableSchemaRegistryEntry {
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

function addEntry(
  byDigest: Map<string, DurableSchemaRegistryEntry>,
  entry: DurableSchemaRegistryEntry,
): void {
  const existing = byDigest.get(entry.descriptor.digest);
  if (existing) {
    // Digest commits to identity/role/version/vendor/projections, so a digest
    // collision with different fields is cryptographically implausible; the
    // duplicate registration is idempotent.
    return;
  }
  byDigest.set(entry.descriptor.digest, entry);
}

function registryOver(byDigest: Map<string, DurableSchemaRegistryEntry>): DurableSchemaRegistry {
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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function",
  );
}
