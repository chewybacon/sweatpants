import { type EffectDefinition } from "@sweatpants/durable-effects";

import { CrankError } from "@sweatpants/durable-execution";
import {
  canonicalJson,
  canonicalSnapshot,
  sha256,
  stableTupleHash,
  type Json,
} from "@sweatpants/foundation";
import {
  verifyProgramIdentityProvenance,
  type ProgramIdentityProvenanceV1,
} from "@sweatpants/durable-execution";
import { assertEffectDefinition } from "@sweatpants/durable-effects/authoring";
import { type SchemaBinding } from "@sweatpants/foundation/schema";
import { sortedResourceValues, type ResourcePackage } from "../resource/index.ts";
import {
  AGENT_MANIFEST_DOMAIN,
  AGENT_MANIFEST_FORMAT,
  type AdvertisedCapabilityV1,
  type AgentDefinition,
  type AgentManifestV1,
  type AgentProgramBinding,
  type AgentProgramInput,
  type DefineAgentOptions,
  type PinnedAgentProgramV1,
} from "./types.ts";

type ErasedDurableTool = AgentProgramBinding["program"];

const DIGEST_RE = /^[0-9a-f]{64}$/;
const STABLE_ID_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;
const MAX_DESCRIPTION_BYTES = 16 * 1024;
const MAX_CAPABILITY_TEXT_BYTES = 4 * 1024;

export class AgentAuthoringError extends CrankError {
  readonly _agentAuthoringTag = "AgentAuthoringError";
}

export function advertiseCapability(input: AdvertisedCapabilityV1): AdvertisedCapabilityV1 {
  return freezeCapability(input);
}

/** Explicit helper for exporting one exact program without changing model visibility. */
export function exportProgram<I extends Json, O extends Json>(
  program: AgentProgramInput<I, O>,
): AgentProgramInput<I, O> {
  return program;
}

export function defineAgent(options: DefineAgentOptions): AgentDefinition {
  assertExactKeys(options, [
    "identity",
    "description",
    "conversation",
    "programs",
    "advertisedCapabilities",
    "releaseStrict",
  ]);
  const name = stableId(options.identity?.name, "agent name");
  const version = boundedText(options.identity?.version, 128, "agent version");
  const description = boundedText(options.description, MAX_DESCRIPTION_BYTES, "agent description");
  const conversation = options.conversation
    ? normalizeBinding(options.conversation, options.releaseStrict)
    : undefined;
  const programs: Record<string, AgentProgramBinding> = {};
  for (const key of sortedKeys(options.programs ?? {})) {
    const alias = stableId(key, "entrypoint name");
    programs[alias] = normalizeBinding(options.programs![key]!, options.releaseStrict);
  }
  const capabilities: Record<string, AdvertisedCapabilityV1> = {};
  for (const key of sortedKeys(options.advertisedCapabilities ?? {})) {
    const id = stableId(key, "capability key");
    const capability = freezeCapability(options.advertisedCapabilities![key]!);
    if (capability.id !== id) {
      invalidAgent("capability record key must equal capability ID");
    }
    capabilities[id] = capability;
  }

  const allBindings: AgentProgramBinding[] = [
    ...(conversation ? [conversation] : []),
    ...Object.values(programs),
  ];
  assertIdentityConflicts(allBindings);
  const effects = aggregateEffects(allBindings);
  const schemas = aggregateSchemas(allBindings);
  const resources = aggregateResources(allBindings);
  const projection = {
    format: AGENT_MANIFEST_FORMAT,
    identity: { name, version },
    description,
    ...(conversation ? { conversation: pinned(conversation.program) } : {}),
    programs: Object.fromEntries(
      Object.entries(programs).map(([alias, binding]) => [alias, pinned(binding.program)]),
    ),
    advertisedCapabilities: capabilities,
  };
  const manifestDigest = sha256(AGENT_MANIFEST_DOMAIN + canonicalJson(projection));
  const manifest = deepFreeze(
    canonicalSnapshot({
      ...projection,
      identity: { name, version, digest: manifestDigest },
    }).value as unknown as AgentManifestV1,
  );
  const bindings = Object.freeze({
    ...(conversation ? { conversation } : {}),
    programs: Object.freeze(programs),
    effects: Object.freeze(effects),
    schemas: Object.freeze(schemas),
    resources: Object.freeze(resources),
  });
  return Object.freeze({
    kind: "sweatpants.agent-definition.v1" as const,
    manifest,
    bindings,
    toJSON(): never {
      throw new AgentAuthoringError(
        "invalid_agent_manifest",
        "AgentDefinition is runtime-only; serialize definition.manifest explicitly",
      );
    },
  });
}

export function parseAgentManifest(value: unknown): AgentManifestV1 {
  if (!record(value)) {
    invalidAgent("manifest must be an object");
  }
  assertExactKeys(value, [
    "format",
    "identity",
    "description",
    "conversation",
    "programs",
    "advertisedCapabilities",
  ]);
  if (value["format"] !== AGENT_MANIFEST_FORMAT || !record(value["identity"])) {
    invalidAgent("unsupported manifest format");
  }
  const identity = value["identity"];
  assertExactKeys(identity, ["name", "version", "digest"]);
  const name = stableId(identity["name"], "agent name");
  const version = boundedText(identity["version"], 128, "agent version");
  const declaredDigest = requireDigest(identity["digest"], "agent digest");
  const description = boundedText(value["description"], MAX_DESCRIPTION_BYTES, "description");
  const conversation =
    value["conversation"] === undefined ? undefined : parsePinned(value["conversation"]);
  if (!record(value["programs"]) || !record(value["advertisedCapabilities"])) {
    invalidAgent("programs and capabilities must be records");
  }
  const programs: Record<string, PinnedAgentProgramV1> = {};
  for (const key of sortedKeys(value["programs"])) {
    programs[stableId(key, "entrypoint name")] = parsePinned(value["programs"][key]);
  }
  const advertisedCapabilities: Record<string, AdvertisedCapabilityV1> = {};
  for (const key of sortedKeys(value["advertisedCapabilities"])) {
    const id = stableId(key, "capability key");
    const parsed = parseCapability(value["advertisedCapabilities"][key]);
    if (parsed.id !== id) {
      invalidAgent("capability key differs from ID");
    }
    advertisedCapabilities[id] = parsed;
  }
  const projection = {
    format: AGENT_MANIFEST_FORMAT,
    identity: { name, version },
    description,
    ...(conversation ? { conversation } : {}),
    programs,
    advertisedCapabilities,
  };
  const computed = sha256(AGENT_MANIFEST_DOMAIN + canonicalJson(projection));
  if (computed !== declaredDigest) {
    invalidAgent("agent digest mismatch");
  }
  return deepFreeze(
    canonicalSnapshot({ ...projection, identity: { name, version, digest: computed } })
      .value as unknown as AgentManifestV1,
  );
}

export function pinnedAgentProgram(binding: AgentProgramBinding): PinnedAgentProgramV1 {
  return pinned(binding.program);
}

function normalizeBinding(input: AgentProgramInput, releaseStrict = false): AgentProgramBinding {
  const candidate = isProgramBinding(input) ? input.program : input;
  if (!isDurableTool(candidate)) {
    throw new AgentAuthoringError(
      "program_binding_missing",
      "Executable program binding is missing",
    );
  }
  try {
    verifyProgramIdentityProvenance(candidate, { releaseStrict });
  } catch (error) {
    if (error instanceof CrankError && error.code === "asserted_program_identity_forbidden") {
      throw error;
    }
    throw new AgentAuthoringError("invalid_agent_manifest", "Program provenance is invalid");
  }
  const inferredSchemas = programSchemas(candidate);
  const schemas = isProgramBinding(input) ? [...input.schemas] : inferredSchemas;
  const resources = isProgramBinding(input) ? [...input.resources] : programResources(candidate);
  if (schemas.length === 0) {
    throw new AgentAuthoringError(
      "program_binding_missing",
      "Program input/output runtime schema bindings are missing",
    );
  }
  assertSchemaCoverage(candidate, schemas);
  return Object.freeze({
    program: candidate,
    schemas: Object.freeze(schemas),
    resources: Object.freeze(resources),
    ...(isProgramBinding(input) && input.readers
      ? { readers: input.readers }
      : programReaders(candidate)),
  });
}

function assertSchemaCoverage(program: ErasedDurableTool, schemas: readonly SchemaBinding[]): void {
  const installed = new Set(schemas.map((entry) => entry.descriptor.digest));
  const manifest = program.manifest;
  const required = [
    manifest.inputSchema,
    manifest.outputSchema,
    ...Object.values(manifest.elicits).flatMap((declaration) => [
      declaration.response,
      ...(declaration.context ? [declaration.context] : []),
    ]),
    ...Object.values(manifest.effects).flatMap((definition) => [
      definition.inputSchema,
      definition.outputSchema,
      ...(definition.cancellation ? [definition.cancellation.partialSchema] : []),
    ]),
  ];
  const missing = required.filter(
    (descriptor) => descriptor.role !== "builtin" && !installed.has(descriptor.digest),
  );
  if (missing.length > 0) {
    throw new AgentAuthoringError(
      "program_binding_missing",
      `Program schema catalog is missing ${missing.map((descriptor) => descriptor.identity).join(", ")}`,
    );
  }
}

function aggregateEffects(
  bindings: readonly AgentProgramBinding[],
): Record<string, EffectDefinition<Json, Json, Json>> {
  const result: Record<string, EffectDefinition<Json, Json, Json>> = {};
  for (const binding of bindings) {
    for (const [name, definition] of Object.entries(binding.program.manifest.effects)) {
      assertEffectDefinition(definition);
      const current = result[name];
      if (current && canonicalJson(current) !== canonicalJson(definition)) {
        throw new AgentAuthoringError(
          "effect_contract_conflict",
          "Programs declare conflicting exact effect contracts",
        );
      }
      result[name] = definition;
    }
  }
  return result;
}

function aggregateSchemas(bindings: readonly AgentProgramBinding[]): SchemaBinding[] {
  const byDigest = new Map<string, SchemaBinding>();
  for (const binding of bindings) {
    for (const entry of binding.schemas) {
      byDigest.set(entry.descriptor.digest, entry);
    }
  }
  return sortedResourceValues(byDigest.values(), (a, b) =>
    a.descriptor.digest.localeCompare(b.descriptor.digest),
  );
}

function aggregateResources(bindings: readonly AgentProgramBinding[]): ResourcePackage[] {
  const byDigest = new Map<string, ResourcePackage>();
  for (const binding of bindings) {
    for (const resource of binding.resources) {
      byDigest.set(resource.manifest.digest, resource);
    }
  }
  return sortedResourceValues(byDigest.values(), (a, b) =>
    a.manifest.digest.localeCompare(b.manifest.digest),
  );
}

function assertIdentityConflicts(bindings: readonly AgentProgramBinding[]): void {
  const byIdVersion = new Map<string, string>();
  for (const binding of bindings) {
    const manifest = binding.program.manifest;
    const key = stableTupleHash([manifest.programId, manifest.version]);
    const current = byIdVersion.get(key);
    if (current && current !== manifest.digest) {
      invalidAgent("conflicting pinned program identities");
    }
    byIdVersion.set(key, manifest.digest);
  }
}

function pinned(tool: ErasedDurableTool): PinnedAgentProgramV1 {
  return deepFreeze({
    id: tool.manifest.programId,
    version: tool.manifest.version,
    digest: tool.manifest.digest,
    provenance: canonicalSnapshot(tool.identityProvenance).value as ProgramIdentityProvenanceV1,
  });
}

function freezeCapability(input: AdvertisedCapabilityV1): AdvertisedCapabilityV1 {
  if (!record(input)) {
    invalidAgent("capability must be an object");
  }
  assertExactKeys(input, [
    "id",
    "name",
    "description",
    "tags",
    "examples",
    "inputModes",
    "outputModes",
    "authorization",
  ]);
  const value = {
    id: stableId(input.id, "capability ID"),
    name: boundedText(input.name, 512, "capability name"),
    description: boundedText(
      input.description,
      MAX_CAPABILITY_TEXT_BYTES,
      "capability description",
    ),
    tags: stringList(input.tags, 64, 128, "capability tags"),
    examples: stringList(input.examples, 32, 2048, "capability examples"),
    inputModes: stringList(input.inputModes, 32, 256, "input modes"),
    outputModes: stringList(input.outputModes, 32, 256, "output modes"),
    authorization: stableId(input.authorization, "authorization policy"),
  };
  return deepFreeze(canonicalSnapshot(value).value as unknown as AdvertisedCapabilityV1);
}

function parseCapability(value: unknown): AdvertisedCapabilityV1 {
  return freezeCapability(value as AdvertisedCapabilityV1);
}

function parsePinned(value: unknown): PinnedAgentProgramV1 {
  if (!record(value)) {
    invalidAgent("pinned program must be an object");
  }
  assertExactKeys(value, ["id", "version", "digest", "provenance"]);
  const provenance = parseProvenance(value["provenance"]);
  return deepFreeze({
    id: stableId(value["id"], "program ID"),
    version: boundedText(value["version"], 128, "program version"),
    digest: requireDigest(value["digest"], "program digest"),
    provenance,
  });
}

function parseProvenance(value: unknown): ProgramIdentityProvenanceV1 {
  if (
    !record(value) ||
    !["asserted", "generated-interface", "generated-artifact"].includes(String(value["kind"]))
  ) {
    invalidAgent("invalid program identity provenance");
  }
  if (value["kind"] === "asserted") {
    assertExactKeys(value, ["kind"]);
    return Object.freeze({ kind: "asserted" });
  }
  assertExactKeys(value, ["kind", "format", "generatorVersion", "identityInputDigest"]);
  const format =
    value["kind"] === "generated-interface"
      ? "sweatpants.program-interface-identity.v1"
      : "sweatpants.program-artifact-identity.v1";
  if (
    value["format"] !== format ||
    !Number.isSafeInteger(value["generatorVersion"]) ||
    Number(value["generatorVersion"]) <= 0
  ) {
    invalidAgent("invalid generated provenance");
  }
  return Object.freeze({
    kind: value["kind"],
    format,
    generatorVersion: Number(value["generatorVersion"]),
    identityInputDigest: requireDigest(value["identityInputDigest"], "identity input digest"),
  }) as ProgramIdentityProvenanceV1;
}

function isProgramBinding(value: AgentProgramInput): value is AgentProgramBinding {
  return record(value) && isDurableTool(value["program"]);
}
function isDurableTool(value: unknown): value is ErasedDurableTool {
  return Boolean(
    record(value) &&
    value["durability"] === "crank_native" &&
    record(value["manifest"]) &&
    typeof value["program"] === "function",
  );
}
function programSchemas(program: ErasedDurableTool): SchemaBinding[] {
  const value = program as ErasedDurableTool & {
    readonly schemaCatalog?: readonly SchemaBinding[];
    readonly artifacts?: { readonly catalog?: readonly SchemaBinding[] };
  };
  return [...(value.schemaCatalog ?? value.artifacts?.catalog ?? [])];
}
function programResources(program: ErasedDurableTool): ResourcePackage[] {
  const value = program as ErasedDurableTool & {
    readonly resourcePackages?: readonly ResourcePackage[];
  };
  return [...(value.resourcePackages ?? [])];
}
function programReaders(program: ErasedDurableTool) {
  const value = program as ErasedDurableTool & {
    readonly resourceReaders?: AgentProgramBinding["readers"];
  };
  return value.resourceReaders ? { readers: value.resourceReaders } : {};
}

function stringList(
  value: unknown,
  maxItems: number,
  maxBytes: number,
  field: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    invalidAgent(`${field} is invalid`);
  }
  const result = value.map((item) => boundedText(item, maxBytes, field));
  if (new Set(result).size !== result.length) {
    invalidAgent(`${field} must be duplicate-free`);
  }
  return Object.freeze(result);
}
function stableId(value: unknown, field: string): string {
  if (typeof value !== "string" || !STABLE_ID_RE.test(value)) {
    invalidAgent(`${field} is invalid`);
  }
  return value;
}
function boundedText(value: unknown, maxBytes: number, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    invalidAgent(`${field} is invalid`);
  }
  return value;
}
function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) {
    invalidAgent(`${field} is invalid`);
  }
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function sortedKeys(value: object): string[] {
  return sortedResourceValues(Object.keys(value), (a, b) => a.localeCompare(b));
}
function assertExactKeys(value: object, allowed: readonly string[]): void {
  const actual = Object.keys(value);
  const accepted = new Set(allowed);
  if (actual.some((key) => !accepted.has(key))) {
    invalidAgent("unknown field");
  }
}
function invalidAgent(message: string): never {
  throw new AgentAuthoringError("invalid_agent_manifest", `Invalid agent manifest: ${message}`);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
