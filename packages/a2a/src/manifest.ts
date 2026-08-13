import { durableEffectKey, type DurableEffectRegistry } from "@sweatpants/durable-effects";

import { canonicalJson, canonicalSnapshot, parser } from "@sweatpants/foundation";
import { durableEffectRuntimeSchemas } from "@sweatpants/durable-effects";
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
import { z } from "zod";

export interface FetchRemoteProgramManifestOptions {
  endpoint: string;
  program: PinnedProgram;
  cardOrigin: string;
  httpClient?: A2AHttpClient;
  authorization?: A2AAuthorizationProvider;
  urlPolicy?: A2AUrlPolicy;
  signal?: AbortSignal;
}

const pinnedProgramSchema = z.strictObject({
  id: z.string().min(1).max(256),
  version: z.string().min(1).max(256),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
});
const manifestDocumentSchema = z.strictObject({
  protocolVersion: z.number().int(),
  extensionUri: z.string().max(512),
  program: pinnedProgramSchema,
  manifest: z.json(),
  manifestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  capabilities: z.strictObject({ ordinaryReplay: z.literal(true), streamedRestore: z.boolean() }),
});
const pinnedProgramParser = parser(pinnedProgramSchema).map(
  (value): PinnedProgram => Object.freeze(value),
);
const manifestDocumentParser = parser(manifestDocumentSchema);

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
  const parsed = manifestDocumentParser.parse(value);
  if (!parsed.ok) {
    throw mismatch("Manifest document fields are not closed");
  }
  if (parsed.value.protocolVersion !== 1) {
    throw a2aError("protocol_version_unsupported", "Unsupported manifest protocol");
  }
  if (parsed.value.extensionUri !== CALLER_AUTHORITATIVE_EXTENSION_URI) {
    throw a2aError("extension_echo_mismatch", "Manifest extension identity does not match");
  }
  const program = pinnedProgramParser.parse(parsed.value.program);
  if (!program.ok) {
    throw mismatch("Invalid manifest program identity");
  }
  if (expectedProgram && canonicalJson(program.value) !== canonicalJson(expectedProgram)) {
    throw mismatch("Manifest program identity does not match the requested artifact");
  }
  const manifest = parseClosedDurableManifest(parsed.value.manifest);
  if (
    manifest.programId !== program.value.id ||
    manifest.version !== program.value.version ||
    manifest.digest !== program.value.digest
  ) {
    throw mismatch("Embedded manifest identity does not match its document identity");
  }
  const computed = canonicalSnapshot(manifest).sha;
  if (parsed.value.manifestDigest !== computed) {
    throw mismatch("Manifest digest does not match canonical manifest content");
  }
  return Object.freeze({
    protocolVersion: 1,
    extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
    program: program.value,
    manifest: Object.freeze(structuredClone(manifest)),
    manifestDigest: computed,
    capabilities: Object.freeze({
      ordinaryReplay: true,
      streamedRestore: parsed.value.capabilities.streamedRestore,
    }),
  });
}

/** Ensures every exact child effect has a compatible caller-owned handler before execution. */
export function preflightRemoteEffectHandlers(
  manifest: DurableProgramManifest,
  registry: DurableEffectRegistry,
): void {
  for (const definition of Object.values(manifest.effects)) {
    const registration = registry.get(durableEffectKey(definition.name, definition.version));
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
  try {
    return canonicalSnapshot(parseDurableManifest(value)).value;
  } catch {
    throw mismatch("Embedded durable manifest is invalid");
  }
}

function mismatch(message: string): ReturnType<typeof a2aError> {
  return a2aError("manifest_mismatch", message);
}
