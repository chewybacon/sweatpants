import { type DurableEffectRegistry } from "@sweatpants/durable-effects";

import {
  canonicalJson,
  canonicalSnapshot,
  parsePortableSchemaDescriptor,
  type Json,
} from "@sweatpants/foundation";
import { durableEffectRuntimeSchemas, type EffectDefinition } from "@sweatpants/durable-effects";
import {
  parseDurableManifest,
  type DurableProgramManifest,
  type PinnedProgram,
} from "@sweatpants/durable-execution";

import {
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  type RemoteProgramManifestDocumentV1,
} from "./types.ts";
import { a2aError } from "./protocol.ts";
import {
  createSecureA2AHttpClient,
  parseA2AJsonResponse,
  requireExtensionEcho,
  type A2AAuthorizationProvider,
  type A2AHttpClient,
} from "./http-client.ts";
import type { A2AUrlPolicy } from "./url-policy.ts";

export interface FetchRemoteProgramManifestOptions {
  endpoint: string;
  program: PinnedProgram;
  cardOrigin: string;
  httpClient?: A2AHttpClient;
  authorization?: A2AAuthorizationProvider;
  urlPolicy?: A2AUrlPolicy;
  signal?: AbortSignal;
}

/**
 * Builds the production manifest provider used by createA2AProgramDriver. It
 * preflights every caller-owned effect contract before the runtime may allocate
 * or attach the remote child.
 */
export function createPreflightedRemoteManifestProvider(
  options: Omit<FetchRemoteProgramManifestOptions, "program"> & {
    effectRegistry: DurableEffectRegistry;
  },
): (program: PinnedProgram) => Promise<RemoteProgramManifestDocumentV1> {
  return async (program) => {
    const document = await fetchRemoteProgramManifest({ ...options, program });
    preflightRemoteEffectHandlers(document.manifest, options.effectRegistry);
    return document;
  };
}

/** Fetches, extension-echo checks, and validates one exact immutable program artifact. */
export async function fetchRemoteProgramManifest(
  options: FetchRemoteProgramManifestOptions,
): Promise<RemoteProgramManifestDocumentV1> {
  const endpoint = new URL(options.endpoint);
  endpoint.search = "";
  endpoint.searchParams.set("id", options.program.id);
  endpoint.searchParams.set("version", options.program.version);
  endpoint.searchParams.set("digest", options.program.digest);
  const response = await (options.httpClient ?? createSecureA2AHttpClient()).get({
    url: endpoint,
    purpose: "manifest",
    cardOrigin: options.cardOrigin,
    activateExtension: true,
    ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
    ...(options.authorization ? { authorization: options.authorization } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (response.status === 401) {
    throw a2aError("authentication_failed", "Manifest authentication failed");
  }
  if (response.status === 403 || response.status === 404) {
    throw a2aError("manifest_not_found", "Requested program manifest is unavailable");
  }
  if (response.status < 200 || response.status >= 300) {
    throw a2aError("transport_lost", `Manifest request failed with status ${response.status}`);
  }
  requireExtensionEcho(response);
  return parseRemoteProgramManifestDocument(parseA2AJsonResponse(response), options.program);
}

export function parseRemoteProgramManifestDocument(
  value: unknown,
  expectedProgram?: PinnedProgram,
): RemoteProgramManifestDocumentV1 {
  if (
    !record(value) ||
    !exactKeys(value, [
      "protocolVersion",
      "extensionUri",
      "program",
      "manifest",
      "manifestDigest",
      "capabilities",
    ])
  ) {
    throw mismatch("Manifest document fields are not closed");
  }
  if (value["protocolVersion"] !== 1) {
    throw a2aError("protocol_version_unsupported", "Unsupported manifest protocol");
  }
  if (value["extensionUri"] !== CALLER_AUTHORITATIVE_EXTENSION_URI) {
    throw a2aError("extension_echo_mismatch", "Manifest extension identity does not match");
  }
  const program = parseProgram(value["program"]);
  if (expectedProgram && canonicalJson(program) !== canonicalJson(expectedProgram)) {
    throw mismatch("Manifest program identity does not match the requested artifact");
  }
  const capabilities = value["capabilities"];
  if (
    !record(capabilities) ||
    !exactKeys(capabilities, ["ordinaryReplay", "streamedRestore"]) ||
    capabilities["ordinaryReplay"] !== true ||
    typeof capabilities["streamedRestore"] !== "boolean"
  ) {
    throw mismatch("Manifest replay capabilities are invalid");
  }
  const manifest = parseClosedDurableManifest(value["manifest"]);
  if (
    manifest.programId !== program.id ||
    manifest.version !== program.version ||
    manifest.digest !== program.digest
  ) {
    throw mismatch("Embedded manifest identity does not match its document identity");
  }
  const computed = canonicalSnapshot(manifest).sha;
  if (!digest(value["manifestDigest"]) || value["manifestDigest"] !== computed) {
    throw mismatch("Manifest digest does not match canonical manifest content");
  }
  return Object.freeze({
    protocolVersion: 1,
    extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
    program,
    manifest: Object.freeze(structuredClone(manifest)),
    manifestDigest: computed,
    capabilities: Object.freeze({
      ordinaryReplay: true,
      streamedRestore: capabilities["streamedRestore"],
    }),
  });
}

/** Ensures every exact child effect has a compatible caller-owned handler before execution. */
export function preflightRemoteEffectHandlers(
  manifest: DurableProgramManifest,
  registry: DurableEffectRegistry,
): void {
  for (const definition of Object.values(manifest.effects)) {
    const registration = registry.get(`${definition.name}@${definition.version}`);
    if (!registration) {
      throw a2aError(
        "effect_handler_missing",
        `Required effect handler is not installed: ${definition.name}@${definition.version}`,
      );
    }
    if (canonicalJson(registration.definition) !== canonicalJson(definition)) {
      throw a2aError(
        "effect_contract_mismatch",
        `Effect contract does not match: ${definition.name}@${definition.version}`,
      );
    }
    const runtimeSchemas = durableEffectRuntimeSchemas(registration);
    if (!runtimeSchemas?.input || !runtimeSchemas.output) {
      throw a2aError(
        "effect_contract_mismatch",
        `Effect runtime validators are missing: ${definition.name}@${definition.version}`,
      );
    }
    if (
      registration.satisfies.mode !== definition.retrySafety.mode ||
      (definition.retrySafety.mode === "idempotent" &&
        (registration.satisfies.mode !== "idempotent" ||
          registration.satisfies.mechanism !== definition.retrySafety.mechanism))
    ) {
      throw a2aError(
        "effect_contract_mismatch",
        `Effect retry contract does not match: ${definition.name}@${definition.version}`,
      );
    }
  }
}

function parseClosedDurableManifest(value: unknown): DurableProgramManifest {
  if (
    !record(value) ||
    !exactKeys(value, [
      "programId",
      "version",
      "digest",
      "inputSchema",
      "outputSchema",
      "elicits",
      "effects",
      "capabilities",
    ]) ||
    !record(value["elicits"]) ||
    !record(value["effects"]) ||
    !record(value["capabilities"])
  ) {
    throw mismatch("Durable manifest fields are not closed");
  }
  parseDescriptor(value["inputSchema"]);
  parseDescriptor(value["outputSchema"]);
  for (const declaration of Object.values(value["elicits"])) {
    if (!record(declaration) || !onlyKeys(declaration, ["response"], ["context"])) {
      throw mismatch("Elicit declaration fields are not closed");
    }
    parseDescriptor(declaration["response"]);
    if (declaration["context"] !== undefined) {
      parseDescriptor(declaration["context"]);
    }
  }
  for (const definition of Object.values(value["effects"])) {
    parseClosedEffect(definition);
  }
  if (!exactKeys(value["capabilities"], ["durableEmissions", "structuredChildren", "replay"])) {
    throw mismatch("Program capability fields are not closed");
  }
  try {
    parseDurableManifest(value);
  } catch (error) {
    throw a2aError("manifest_mismatch", "Embedded durable manifest is invalid", error);
  }
  return canonicalSnapshot(value).value as unknown as DurableProgramManifest;
}

function parseClosedEffect(value: Json): EffectDefinition<Json, Json, Json> {
  if (
    !record(value) ||
    !onlyKeys(
      value,
      ["name", "version", "inputSchema", "outputSchema", "retrySafety"],
      ["cancellation"],
    )
  ) {
    throw mismatch("Effect definition fields are not closed");
  }
  parseDescriptor(value["inputSchema"]);
  parseDescriptor(value["outputSchema"]);
  if (value["cancellation"] !== undefined) {
    if (!record(value["cancellation"]) || !exactKeys(value["cancellation"], ["partialSchema"])) {
      throw mismatch("Effect cancellation fields are not closed");
    }
    parseDescriptor(value["cancellation"]["partialSchema"]);
  }
  if (!record(value["retrySafety"])) {
    throw mismatch("Effect retry safety is invalid");
  }
  const retryMode = value["retrySafety"]["mode"];
  const retryKeys =
    retryMode === "repeatable"
      ? ["mode"]
      : retryMode === "unsafe"
        ? ["mode"]
        : ["mode", "mechanism"];
  if (!exactKeys(value["retrySafety"], retryKeys)) {
    throw mismatch("Effect retry safety fields are not closed");
  }
  return value as unknown as EffectDefinition<Json, Json, Json>;
}

function parseDescriptor(value: unknown): void {
  if (
    !record(value) ||
    !exactKeys(value, [
      "identity",
      "role",
      "version",
      "vendor",
      "inputProjection",
      "outputProjection",
      "fidelity",
      "digest",
    ])
  ) {
    throw mismatch("Schema descriptor fields are not closed");
  }
  if (!record(value["fidelity"]) || !exactKeys(value["fidelity"], ["input", "output"])) {
    throw mismatch("Schema descriptor fidelity fields are not closed");
  }
  try {
    parsePortableSchemaDescriptor(value);
  } catch (error) {
    throw a2aError("manifest_mismatch", "Schema descriptor is invalid", error);
  }
}

function parseProgram(value: unknown): PinnedProgram {
  if (!record(value) || !exactKeys(value, ["id", "version", "digest"])) {
    throw mismatch("Invalid manifest program identity");
  }
  if (!nonempty(value["id"]) || !nonempty(value["version"]) || !digest(value["digest"])) {
    throw mismatch("Invalid manifest program identity");
  }
  return Object.freeze({ id: value["id"], version: value["version"], digest: value["digest"] });
}
function record(value: unknown): value is Record<string, Json> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function exactKeys(value: Record<string, Json>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}
function onlyKeys(
  value: Record<string, Json>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}
function mismatch(message: string): ReturnType<typeof a2aError> {
  return a2aError("manifest_mismatch", message);
}
