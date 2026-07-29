import { type DurableToolRegistry } from "@sweatpants/durable-execution";
import { type DurableProgramManifest, type PinnedProgram } from "@sweatpants/durable-execution";
import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import {
  A2A_EXTENSIONS_HEADER,
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  type A2AProgramRouteV1,
  type CallerAuthoritativeProgramExtensionParamsV1,
  type RemoteProgramManifestDocumentV1,
} from "./types.ts";
import { parseCallerAuthoritativeExtensionParams } from "./discovery.ts";
import { a2aError } from "./protocol.ts";
import { normalizedTransportOrigin } from "./url-policy.ts";

export function createCallerAuthoritativeAgentExtension(
  params: CallerAuthoritativeProgramExtensionParamsV1,
  options: { description?: string; required?: boolean } = {},
): Json {
  const parsed = parseCallerAuthoritativeExtensionParams(params);
  return {
    uri: CALLER_AUTHORITATIVE_EXTENSION_URI,
    description:
      options.description ??
      "Executes exact Sweatpants programs under the caller's sole durable journal authority.",
    required: options.required ?? false,
    params: parsed as unknown as Json,
  };
}

export function createA2AProgramRoute(input: {
  executionId: string;
  driverEndpoint: string;
  cardUrlOrOrigin: string;
}): A2AProgramRouteV1 {
  if (!input.executionId || input.executionId.length > 256) {
    throw a2aError("identity_mismatch", "Invalid opaque execution ID");
  }
  return Object.freeze({
    driverKind: "a2a",
    protocolVersion: 1,
    extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
    executionId: input.executionId,
    driverEndpoint: input.driverEndpoint,
    cardOrigin: normalizedTransportOrigin(input.cardUrlOrOrigin),
  });
}

export function createRemoteProgramManifestDocument(
  manifest: DurableProgramManifest,
  capabilities: { streamedRestore: boolean } = { streamedRestore: true },
): RemoteProgramManifestDocumentV1 {
  const snapshot = canonicalSnapshot(manifest);
  return Object.freeze({
    protocolVersion: 1,
    extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
    program: Object.freeze({
      id: manifest.programId,
      version: manifest.version,
      digest: manifest.digest,
    }),
    manifest: Object.freeze(snapshot.value),
    manifestDigest: snapshot.sha,
    capabilities: Object.freeze({
      ordinaryReplay: true,
      streamedRestore: capabilities.streamedRestore,
    }),
  });
}

export interface A2AManifestServiceRequest {
  readonly method: string;
  readonly url: string | URL;
  readonly activatedExtensions: readonly string[];
  readonly principal?: { principalId: string; tenantId?: string };
}
export interface A2AManifestServiceResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Json;
}

/** Framework-neutral authenticated manifest endpoint implementation. */
export function createA2AManifestService(options: {
  registry: DurableToolRegistry;
  authorize: (
    principal: { principalId: string; tenantId?: string },
    program: PinnedProgram,
  ) => boolean;
  streamedRestore?: boolean;
}): (request: A2AManifestServiceRequest) => A2AManifestServiceResponse {
  return (request) => {
    const safeHeaders = Object.freeze({
      [A2A_EXTENSIONS_HEADER]: CALLER_AUTHORITATIVE_EXTENSION_URI,
    });
    if (request.method !== "GET") {
      return errorResponse(405, "method_not_allowed");
    }
    if (!request.activatedExtensions.includes(CALLER_AUTHORITATIVE_EXTENSION_URI)) {
      return errorResponse(400, "extension_not_activated");
    }
    if (!request.principal) {
      return errorResponse(401, "authentication_failed");
    }
    const url = request.url instanceof URL ? request.url : new URL(request.url);
    const program = queryProgram(url);
    if (!program || !options.authorize(request.principal, program)) {
      return errorResponse(404, "manifest_not_found");
    }
    const tool = options.registry.get(`${program.id}@${program.version}#${program.digest}`);
    if (!tool) {
      return errorResponse(404, "manifest_not_found");
    }
    return {
      status: 200,
      headers: safeHeaders,
      body: createRemoteProgramManifestDocument(tool.manifest, {
        streamedRestore: options.streamedRestore ?? true,
      }) as unknown as Json,
    };
  };
}

function queryProgram(url: URL): PinnedProgram | undefined {
  const allowed = new Set(["id", "version", "digest"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
    return undefined;
  }
  const id = url.searchParams.get("id");
  const version = url.searchParams.get("version");
  const digest = url.searchParams.get("digest");
  if (!id || !version || !digest || !/^[0-9a-f]{64}$/.test(digest)) {
    return undefined;
  }
  if (
    url.searchParams.getAll("id").length !== 1 ||
    url.searchParams.getAll("version").length !== 1 ||
    url.searchParams.getAll("digest").length !== 1
  ) {
    return undefined;
  }
  return { id, version, digest };
}
function errorResponse(status: number, code: string): A2AManifestServiceResponse {
  return {
    status,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: { code, message: "Requested A2A resource is unavailable" },
  };
}
