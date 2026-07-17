import {
  assertJson,
  canonicalSnapshot,
  type Json,
  type PinnedProgram,
} from "@sweatpants/session-contract";
import {
  discoverCallerAuthoritativeProgram,
  discoverForeignA2AAgent,
  discoverSweatpantsPeer,
  fetchRemoteProgramManifest,
  normalizedTransportOrigin,
  type DiscoverA2AProgramOptions,
  type DiscoveredCallerAuthoritativeProgramV1,
  type DiscoveredForeignA2AAgent,
  type ForeignA2ADiscoveryOptions,
  type PeerInvocationPin,
  type RemoteProgramManifestDocumentV1,
  type SweatpantsPeerDiscoveryOptions,
} from "@sweatpants/a2a";
import type { AgentManifestV1, AgentProgramBinding } from "@sweatpants/core";
import { AgentFacadeError } from "./agent-profiles.ts";

export interface ExpectedRemoteProgramContract<I extends Json = Json, O extends Json = Json> {
  readonly agent: AgentManifestV1;
  readonly capabilityId: string;
  readonly entrypoint: string;
  readonly program: AgentProgramBinding<I, O>;
}
export interface RemoteExecutorHandle<I extends Json = Json, O extends Json = Json> {
  readonly posture: "remote-executor";
  readonly discovery: DiscoveredCallerAuthoritativeProgramV1;
  readonly capabilityId: string;
  readonly program: PinnedProgram;
  readonly manifest: RemoteProgramManifestDocumentV1;
  readonly _types?: { readonly input: I; readonly output: O };
}
export interface StandardAgentHandle<T extends Json = Json> {
  readonly posture: "standard-a2a";
  readonly discovery: DiscoveredForeignA2AAgent;
  readonly payloadType?: T;
}
export interface PeerAgentHandle {
  readonly posture: "sweatpants-peer";
  readonly pin: PeerInvocationPin;
}
export interface DynamicRemoteExecutorHandle extends RemoteExecutorHandle<Json, Json> {}
export interface DynamicStandardAgentHandle extends StandardAgentHandle<Json> {}

export async function connectRemoteExecutor<I extends Json, O extends Json>(
  options: DiscoverA2AProgramOptions & { readonly expected: ExpectedRemoteProgramContract<I, O> },
): Promise<RemoteExecutorHandle<I, O>>;
export async function connectRemoteExecutor(
  options: DiscoverA2AProgramOptions & { readonly capabilityId: string },
): Promise<DynamicRemoteExecutorHandle>;
export async function connectRemoteExecutor<I extends Json, O extends Json>(
  options: DiscoverA2AProgramOptions & {
    readonly expected?: ExpectedRemoteProgramContract<I, O>;
    readonly capabilityId?: string;
  },
): Promise<RemoteExecutorHandle<I, O> | DynamicRemoteExecutorHandle> {
  const discovery = await discoverCallerAuthoritativeProgram(options);
  const capabilityId = options.expected?.capabilityId ?? options.capabilityId;
  if (!capabilityId) {
    mismatch("remote_contract_mismatch", "A capability ID is required");
  }
  const program = discovery.programForSkill(capabilityId);
  const manifest = await fetchRemoteProgramManifest({
    endpoint: discovery.extension.params.manifestEndpoint,
    program,
    cardOrigin: sourceOrigin(options.source),
    ...(options.httpClient ? { httpClient: options.httpClient } : {}),
    ...(options.authorization ? { authorization: options.authorization } : {}),
    ...(options.urlPolicy ? { urlPolicy: options.urlPolicy } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (options.expected) {
    const card = discovery.card as Record<string, Json>;
    if (
      card["name"] !== options.expected.agent.identity.name ||
      card["version"] !== options.expected.agent.identity.version
    ) {
      mismatch("remote_contract_mismatch", "Discovered Agent Card identity differs");
    }
    const expected = options.expected.agent.programs[options.expected.entrypoint];
    if (
      !expected ||
      expected.id !== program.id ||
      expected.version !== program.version ||
      expected.digest !== program.digest
    ) {
      mismatch(
        "remote_contract_mismatch",
        "Discovered exact program differs from the expected agent contract",
      );
    }
    if (!options.expected.agent.advertisedCapabilities[capabilityId]) {
      mismatch("remote_contract_mismatch", "Expected capability is absent from the local manifest");
    }
    if (
      canonicalSnapshot(options.expected.program.program.manifest).canonical !==
      canonicalSnapshot(manifest.manifest).canonical
    ) {
      mismatch("remote_contract_mismatch", "Discovered schema or effect contract differs");
    }
  }
  return Object.freeze({
    posture: "remote-executor" as const,
    discovery,
    capabilityId,
    program,
    manifest,
  });
}

export async function connectStandardAgent<T extends Json = Json>(
  options: ForeignA2ADiscoveryOptions & {
    readonly expected?: {
      readonly agentName?: string;
      readonly capabilityId?: string;
      readonly cardDigest?: string;
      readonly payload?: T;
    };
  },
): Promise<StandardAgentHandle<T>> {
  const discovery = await discoverForeignA2AAgent(options);
  if (
    options.expected?.agentName !== undefined &&
    options.expected.agentName !== discovery.agentName
  ) {
    mismatch("remote_contract_mismatch", "Standard Agent Card identity differs");
  }
  if (
    options.expected?.capabilityId !== undefined &&
    options.expected.capabilityId !== discovery.skillId
  ) {
    mismatch("remote_contract_mismatch", "Standard Agent Card capability differs");
  }
  if (
    options.expected?.cardDigest !== undefined &&
    options.expected.cardDigest !== discovery.cardDigest
  ) {
    mismatch("remote_contract_mismatch", "Standard Agent Card digest differs");
  }
  return Object.freeze({ posture: "standard-a2a" as const, discovery });
}

export async function connectPeerAgent(
  options: SweatpantsPeerDiscoveryOptions,
): Promise<PeerAgentHandle> {
  const pin = await discoverSweatpantsPeer(options);
  return Object.freeze({ posture: "sweatpants-peer" as const, pin });
}

export type DurableRemoteReferenceV1 = {
  readonly format: "sweatpants.remote-reference.v1";
  readonly posture: "remote-executor" | "standard-a2a" | "sweatpants-peer";
  readonly cardDigest: string;
  readonly interface: Json;
  readonly capabilityId: string;
  readonly program?: PinnedProgram;
  readonly guarantee?: Json;
  readonly grantReference?: Json;
  readonly expiresAt?: string;
};

export function createDurableRemoteReference(
  input: DurableRemoteReferenceV1,
): DurableRemoteReferenceV1 {
  const allowed = new Set([
    "format",
    "posture",
    "cardDigest",
    "interface",
    "capabilityId",
    "program",
    "guarantee",
    "grantReference",
    "expiresAt",
  ]);
  if (
    !input ||
    input.format !== "sweatpants.remote-reference.v1" ||
    !["remote-executor", "standard-a2a", "sweatpants-peer"].includes(input.posture) ||
    !/^[0-9a-f]{64}$/.test(input.cardDigest) ||
    typeof input.capabilityId !== "string" ||
    input.capabilityId.length === 0 ||
    Object.keys(input).some((key) => !allowed.has(key)) ||
    (input.program !== undefined &&
      (!input.program.id || !input.program.version || !/^[0-9a-f]{64}$/.test(input.program.digest)))
  ) {
    mismatch("remote_contract_mismatch", "Invalid durable remote reference");
  }
  if (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt))) {
    mismatch("remote_contract_mismatch", "Invalid remote reference expiration");
  }
  return deepFreeze(
    canonicalSnapshot(assertJson(input)).value as unknown as DurableRemoteReferenceV1,
  );
}

export function assertRemoteReferenceUsable(
  reference: DurableRemoteReferenceV1,
  posture: DurableRemoteReferenceV1["posture"],
  now = new Date(),
): void {
  const parsed = createDurableRemoteReference(reference);
  if (parsed.posture !== posture) {
    mismatch("remote_posture_mismatch", "Durable remote reference posture differs");
  }
  if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= now.getTime()) {
    mismatch("remote_pin_expired", "Durable remote reference has expired");
  }
}

export function requireRemoteExecutorHandle(value: RemoteExecutorHandle): RemoteExecutorHandle {
  if (!value || value.posture !== "remote-executor") {
    mismatch("remote_posture_mismatch", "Remote-executor handle required");
  }
  return value;
}
export function requireStandardAgentHandle(value: StandardAgentHandle): StandardAgentHandle {
  if (!value || value.posture !== "standard-a2a") {
    mismatch("remote_posture_mismatch", "Standard-agent handle required");
  }
  return value;
}
export function requirePeerAgentHandle(value: PeerAgentHandle): PeerAgentHandle {
  if (!value || value.posture !== "sweatpants-peer") {
    mismatch("remote_posture_mismatch", "Peer-agent handle required");
  }
  return value;
}

function sourceOrigin(source: DiscoverA2AProgramOptions["source"]): string {
  if ("origin" in source) {
    return normalizedTransportOrigin(source.origin);
  }
  if ("cardOrigin" in source && source.cardOrigin) {
    return normalizedTransportOrigin(source.cardOrigin);
  }
  if ("cardUrl" in source && source.cardUrl) {
    return normalizedTransportOrigin(source.cardUrl);
  }
  mismatch("remote_contract_mismatch", "Agent Card origin is required for manifest validation");
}

function mismatch(
  code: "remote_contract_mismatch" | "remote_posture_mismatch" | "remote_pin_expired",
  message: string,
): never {
  throw new AgentFacadeError(code, message);
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
