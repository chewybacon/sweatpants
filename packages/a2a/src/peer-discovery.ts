import {
  CrankError,
  canonicalSnapshot,
  type DurableEffectRegistry,
  type Json,
} from "@sweatpants/session-contract";
import {
  discoverForeignA2AAgent,
  prepareForeignA2AInvocation,
  type ForeignA2ADiscoveryOptions,
} from "./foreign-discovery.ts";
import {
  createSecureA2AHttpClient,
  parseA2AJsonResponse,
  type A2AAuthorizationProvider,
  type A2AHttpClient,
} from "./http-client.ts";
import { peerAdapterChild } from "./peer-adapter.ts";
import type {
  ForeignA2AMessage,
  ForeignA2AStartRequest,
  ForeignA2ATask,
} from "./foreign-task-types.ts";
import {
  buildPeerOffer,
  negotiatePeerGrantSet,
  parsePeerRequirementManifest,
} from "./peer-contracts.ts";
import {
  DELEGATED_EFFECTS_EXTENSION_URI,
  SWEATPANTS_PEER_PROFILE_URI,
  type PeerEffectOffer,
  type PeerInvocationPin,
  type PeerRetentionV1,
  type SweatpantsPeerProfileParamsV1,
} from "./peer-types.ts";
import { validateA2AUrl, type A2AUrlPolicy } from "./url-policy.ts";

export interface SweatpantsPeerDiscoveryOptions extends Omit<
  ForeignA2ADiscoveryOptions,
  "minimumGuarantee" | "ambiguityPolicy"
> {
  readonly derivationKey: string | Uint8Array;
  readonly localIdentity: Json;
  readonly calleeIdentity: string;
  readonly effectRegistry: DurableEffectRegistry;
  readonly routes: Readonly<Record<string, PeerEffectOffer>>;
  readonly grantLifetimeMs?: number;
  readonly amendmentRequests?: boolean;
  readonly lineage?: string[];
  readonly httpClient?: A2AHttpClient;
  readonly authorization?: A2AAuthorizationProvider;
  readonly urlPolicy?: A2AUrlPolicy;
}

export async function discoverSweatpantsPeer(
  options: SweatpantsPeerDiscoveryOptions,
): Promise<PeerInvocationPin> {
  const foreign = await discoverForeignA2AAgent({
    ...options,
    minimumGuarantee: "reconciled",
    ambiguityPolicy: "surface",
  });
  for (const required of [SWEATPANTS_PEER_PROFILE_URI, DELEGATED_EFFECTS_EXTENSION_URI])
    if (!foreign.extensionUris.includes(required))
      throw new CrankError(
        "peer_profile_unavailable",
        `Required peer extension is missing: ${required}`,
      );
  const profileDeclaration = extension(foreign.card, SWEATPANTS_PEER_PROFILE_URI);
  const profile = parsePeerProfileParams(profileDeclaration["params"]);
  await Promise.all([
    validateA2AUrl(profile.requirementManifestEndpoint, {
      purpose: "manifest",
      ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
      cardOrigin: foreign.cardOrigin,
    }),
    validateA2AUrl(profile.delegatedEffectsEndpoint, {
      purpose: "manifest",
      ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
      cardOrigin: foreign.cardOrigin,
    }),
  ]);
  const endpoint = new URL(profile.requirementManifestEndpoint);
  endpoint.searchParams.set("skillId", options.skillId);
  const response = await (options.httpClient ?? createSecureA2AHttpClient()).get({
    url: endpoint,
    purpose: "manifest",
    cardOrigin: foreign.cardOrigin,
    extensionUris: [SWEATPANTS_PEER_PROFILE_URI, DELEGATED_EFFECTS_EXTENSION_URI],
    ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
    ...(options.authorization ? { authorization: options.authorization } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (response.status < 200 || response.status >= 300)
    throw new CrankError("peer_manifest_unavailable", "Peer requirement manifest is unavailable");
  requireExtensionEcho(response.headers, SWEATPANTS_PEER_PROFILE_URI);
  requireExtensionEcho(response.headers, DELEGATED_EFFECTS_EXTENSION_URI);
  const manifest = parsePeerRequirementManifest(parseA2AJsonResponse(response));
  if (manifest.skillId !== options.skillId)
    throw new CrankError("peer_manifest_invalid", "Peer requirement manifest skill differs");
  const invocation = prepareForeignA2AInvocation({
    discovery: foreign,
    derivationKey: options.derivationKey,
    localIdentity: options.localIdentity,
    principalId: options.principalId,
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
  });
  const offer = buildPeerOffer({
    manifest,
    routes: options.routes,
    effectRegistry: options.effectRegistry,
    ...(options.amendmentRequests !== undefined
      ? { amendmentRequests: options.amendmentRequests }
      : {}),
    ...(options.lineage ? { lineage: options.lineage } : {}),
  });
  const now = options.now ?? new Date();
  const grantSet = negotiatePeerGrantSet({
    manifest,
    offer,
    callerIdentity: options.principalId,
    calleeIdentity: options.calleeIdentity,
    invocationId: invocation.invocationId,
    expiresAt: new Date(now.getTime() + (options.grantLifetimeMs ?? 60 * 60_000)).toISOString(),
  });
  return Object.freeze({
    foreign: invocation,
    calleeIdentity: options.calleeIdentity,
    requirementManifest: manifest,
    grantSet,
    profile,
    retentionExpiresAt: retentionExpirations(profile.retention, now),
  });
}

export function createPeerStartRequest(input: {
  pin: PeerInvocationPin;
  parts: ForeignA2AMessage["parts"];
  acceptedOutputModes?: string[];
}): ForeignA2AStartRequest {
  const metadata = {
    [SWEATPANTS_PEER_PROFILE_URI]: {
      protocolVersion: 1,
      requirementManifestDigest: input.pin.requirementManifest.manifestDigest,
      grantSetDigest: input.pin.grantSet.digest,
      offer: {
        protocolVersion: 1,
        skillId: input.pin.requirementManifest.skillId,
        requirementManifestDigest: input.pin.requirementManifest.manifestDigest,
        grants: input.pin.grantSet.grants.map((grant) => ({
          grantId: grant.grantId,
          grantVersion: grant.grantVersion,
          contractDigest: grant.contract.contractDigest,
          route: grant.route,
          ...(grant.constraints !== undefined ? { constraints: grant.constraints } : {}),
          ...(grant.budget !== undefined ? { budget: grant.budget } : {}),
          delegation: grant.delegation,
        })),
        amendmentRequests: input.pin.grantSet.amendmentRequests,
      },
    },
  };
  return {
    pin: input.pin.foreign,
    message: {
      messageId: input.pin.foreign.initialMessageId,
      role: "user",
      parts: input.parts,
      metadata,
      extensions: [SWEATPANTS_PEER_PROFILE_URI, DELEGATED_EFFECTS_EXTENSION_URI],
    },
    ...(input.acceptedOutputModes ? { acceptedOutputModes: [...input.acceptedOutputModes] } : {}),
  };
}

/** Product-level name makes callee authority distinct from caller-authoritative invoke. */
export function callPeerAgent(pin: PeerInvocationPin, request: ForeignA2AStartRequest) {
  return peerAdapterChild(pin, request);
}

export function verifyPeerTaskEcho(task: ForeignA2ATask, pin: PeerInvocationPin): void {
  if (!task.metadata || typeof task.metadata !== "object" || Array.isArray(task.metadata))
    throw new CrankError("peer_grant_echo_mismatch", "Peer task omitted profile metadata");
  const profile = task.metadata[SWEATPANTS_PEER_PROFILE_URI];
  if (
    !profile ||
    typeof profile !== "object" ||
    Array.isArray(profile) ||
    profile["grantSetDigest"] !== pin.grantSet.digest ||
    profile["requirementManifestDigest"] !== pin.requirementManifest.manifestDigest
  )
    throw new CrankError("peer_grant_echo_mismatch", "Peer task grant/manifest echo differs");
}

export function parsePeerProfileParams(value: unknown): SweatpantsPeerProfileParamsV1 {
  if (
    !record(value) ||
    !onlyKeys(
      value,
      [
        "protocolVersion",
        "delegatedEffectsVersion",
        "requirementManifestEndpoint",
        "delegatedEffectsEndpoint",
        "retention",
      ],
      ["terminalEvidenceKeyId"],
    ) ||
    value["protocolVersion"] !== 1 ||
    value["delegatedEffectsVersion"] !== 1 ||
    typeof value["requirementManifestEndpoint"] !== "string" ||
    typeof value["delegatedEffectsEndpoint"] !== "string" ||
    !record(value["retention"])
  )
    throw new CrankError("peer_profile_invalid", "Invalid Sweatpants peer profile parameters");
  const retention = value["retention"];
  const keys: Array<keyof PeerRetentionV1> = [
    "taskSeconds",
    "invocationBindingSeconds",
    "effectEventSeconds",
    "grantSeconds",
    "effectResponseSeconds",
    "cancellationEvidenceSeconds",
    "terminalEvidenceSeconds",
  ];
  if (!exactKeys(retention, keys))
    throw new CrankError("peer_profile_invalid", "Invalid peer retention declaration");
  for (const key of keys)
    if (!Number.isSafeInteger(retention[key]) || Number(retention[key]) <= 0)
      throw new CrankError("peer_profile_invalid", `Invalid peer retention ${key}`);
  if (
    value["terminalEvidenceKeyId"] !== undefined &&
    typeof value["terminalEvidenceKeyId"] !== "string"
  )
    throw new CrankError("peer_profile_invalid", "Invalid terminal evidence key ID");
  return Object.freeze({
    protocolVersion: 1,
    delegatedEffectsVersion: 1,
    requirementManifestEndpoint: value["requirementManifestEndpoint"],
    delegatedEffectsEndpoint: value["delegatedEffectsEndpoint"],
    retention: canonicalSnapshot(retention).value as PeerRetentionV1,
    ...(typeof value["terminalEvidenceKeyId"] === "string"
      ? { terminalEvidenceKeyId: value["terminalEvidenceKeyId"] }
      : {}),
  });
}

function extension(card: Json, uri: string): Record<string, Json> {
  if (
    !record(card) ||
    !record(card["capabilities"]) ||
    !Array.isArray(card["capabilities"]["extensions"])
  )
    throw new CrankError(
      "peer_profile_unavailable",
      "Agent Card extension declarations are invalid",
    );
  const selected = card["capabilities"]["extensions"].find(
    (candidate) => record(candidate) && candidate["uri"] === uri,
  );
  if (!record(selected))
    throw new CrankError("peer_profile_unavailable", "Peer profile is unavailable");
  return selected;
}
function retentionExpirations(
  retention: PeerRetentionV1,
  now: Date,
): Record<keyof PeerRetentionV1, string> {
  return Object.fromEntries(
    Object.entries(retention).map(([key, seconds]) => [
      key,
      new Date(now.getTime() + seconds * 1_000).toISOString(),
    ]),
  ) as Record<keyof PeerRetentionV1, string>;
}
function requireExtensionEcho(headers: Readonly<Record<string, string>>, uri: string): void {
  const value = headers["a2a-extensions"] ?? headers["A2A-Extensions"];
  if (
    !value
      ?.split(",")
      .map((part) => part.trim())
      .includes(uri)
  )
    throw new CrankError("extension_echo_mismatch", `Peer extension was not echoed: ${uri}`);
}
function record(value: unknown): value is Record<string, Json> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
