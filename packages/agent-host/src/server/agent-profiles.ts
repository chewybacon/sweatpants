import { type DurableEffectRegistration, type EffectDefinition } from "@sweatpants/durable-effects";

import { type DurableToolRegistry } from "@sweatpants/durable-execution";
import { CrankError } from "@sweatpants/durable-execution";
import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { canonicalJson, canonicalSnapshot, type Json } from "@sweatpants/foundation";
import {
  DELEGATED_EFFECTS_EXTENSION_URI,
  DURABLE_INVOCATION_EXTENSION_URI,
  SWEATPANTS_PEER_PROFILE_URI,
  createCallerAuthoritativeAgentExtension,
  createPeerRequirementManifest,
  createRemoteProgramManifestDocument,
  definePeerEffectContract,
  parseCallerAuthoritativeExtensionParams,
  parseDurableInvocationParams,
  parsePeerProfileParams,
  parsePeerRequirementManifest,
  type DurableInvocationExtensionParamsV1,
  type PeerEffectRequirementManifest,
  type PeerEffectRoute,
  type PeerRetentionV1,
  type RemoteProgramManifestDocumentV1,
} from "@sweatpants/a2a";
import {
  defineAgent,
  type AgentDefinition,
  type AgentProgramBinding,
  type AdvertisedCapabilityV1,
} from "@sweatpants/agent-sdk";
import type {
  BoundStandardA2AHost,
  StandardA2AHistoryProjection,
  StandardA2AHostPort,
} from "./standard-a2a-host.ts";

export type AgentProfileKind = "remote-executor" | "standard-a2a" | "sweatpants-peer";
export type AgentFacadeErrorCode =
  | "profile_required"
  | "profile_incompatible"
  | "effect_route_missing"
  | "effect_route_incompatible"
  | "remote_contract_mismatch"
  | "remote_posture_mismatch"
  | "remote_pin_expired";

export class AgentFacadeError extends CrankError {
  readonly _agentFacadeTag = "AgentFacadeError";
}

export type { PublicAgentDeployment } from "./agent-profile-types.ts";
import type { PublicAgentDeployment } from "./agent-profile-types.ts";
export interface RemoteExecutorProfile {
  readonly kind: "remote-executor";
  readonly deployment: PublicAgentDeployment & {
    readonly manifestEndpoint: string;
    readonly driverEndpoint: string;
  };
  readonly bindings: Readonly<Record<string, string>>;
  readonly streamedRestore: boolean;
}
export interface StandardA2AProfile {
  readonly kind: "standard-a2a";
  readonly deployment: PublicAgentDeployment;
  readonly handlers: readonly DurableEffectRegistration[];
  readonly capabilityBindings: Readonly<Record<string, string>>;
  readonly historyProjection?: StandardA2AHistoryProjection;
  readonly host?: StandardA2AHostPort;
}
export interface PeerEffectRoutePolicy {
  readonly route: Exclude<PeerEffectRoute, "denied">;
  readonly required?: boolean;
  readonly handler?: DurableEffectRegistration;
}
export interface SweatpantsPeerProfile {
  readonly kind: "sweatpants-peer";
  readonly deployment: PublicAgentDeployment & {
    readonly requirementManifestEndpoint: string;
    readonly delegatedEffectsEndpoint: string;
    readonly retention: PeerRetentionV1;
    readonly durableInvocation: DurableInvocationExtensionParamsV1;
  };
  readonly bindings: Readonly<Record<string, string>>;
  readonly effects: Readonly<Record<string, PeerEffectRoutePolicy>>;
  readonly amendmentRequests: boolean;
}
export type AgentServingProfile =
  | RemoteExecutorProfile
  | StandardA2AProfile
  | SweatpantsPeerProfile;

export interface AgentProjectionBase<K extends AgentProfileKind> {
  readonly posture: K;
  readonly readiness: boolean;
  readonly card: Json;
  readonly interfaces: readonly Json[];
  readonly extensions: readonly Json[];
  readonly definition: AgentDefinition;
  selfCheck(): { readonly ok: boolean; readonly checks: readonly string[] };
}
export interface RemoteExecutorServedAgent extends AgentProjectionBase<"remote-executor"> {
  readonly registry: DurableToolRegistry;
  readonly manifests: Readonly<Record<string, RemoteProgramManifestDocumentV1>>;
}
export interface StandardA2AServedAgent extends AgentProjectionBase<"standard-a2a"> {
  readonly descriptor: StandardA2AProfile;
  readonly host?: StandardA2AHostPort | BoundStandardA2AHost;
}
export interface SweatpantsPeerServedAgent extends AgentProjectionBase<"sweatpants-peer"> {
  readonly requirements: Readonly<Record<string, PeerEffectRequirementManifest>>;
  readonly localHandlers: readonly DurableEffectRegistration[];
}
export type ServedAgent =
  | RemoteExecutorServedAgent
  | StandardA2AServedAgent
  | SweatpantsPeerServedAgent;

export function remoteExecutor(
  options: Omit<RemoteExecutorProfile, "kind" | "streamedRestore"> & {
    readonly streamedRestore?: boolean;
  },
): RemoteExecutorProfile {
  return Object.freeze({
    kind: "remote-executor",
    deployment: Object.freeze({ ...options.deployment }),
    bindings: Object.freeze({ ...options.bindings }),
    streamedRestore: options.streamedRestore ?? true,
  });
}
export function standardA2A(options: Omit<StandardA2AProfile, "kind">): StandardA2AProfile {
  return Object.freeze({
    kind: "standard-a2a",
    deployment: Object.freeze({ ...options.deployment }),
    handlers: Object.freeze([...options.handlers]),
    capabilityBindings: Object.freeze({ ...options.capabilityBindings }),
    historyProjection: options.historyProjection ?? "accepted-context",
    ...(options.host ? { host: options.host } : {}),
  });
}
export function sweatpantsPeer(
  options: Omit<SweatpantsPeerProfile, "kind" | "amendmentRequests"> & {
    readonly amendmentRequests?: boolean;
  },
): SweatpantsPeerProfile {
  return Object.freeze({
    kind: "sweatpants-peer",
    deployment: Object.freeze({ ...options.deployment }),
    bindings: Object.freeze({ ...options.bindings }),
    effects: Object.freeze({ ...options.effects }),
    amendmentRequests: options.amendmentRequests ?? false,
  });
}

export function serveAgent(
  definition: AgentDefinition,
  profile: RemoteExecutorProfile,
): RemoteExecutorServedAgent;
export function serveAgent(
  definition: AgentDefinition,
  profile: StandardA2AProfile,
): StandardA2AServedAgent;
export function serveAgent(
  definition: AgentDefinition,
  profile: SweatpantsPeerProfile,
): SweatpantsPeerServedAgent;
export function serveAgent(definition: AgentDefinition, profile: AgentServingProfile): ServedAgent;
export function serveAgent(definition: AgentDefinition, profile: AgentServingProfile): ServedAgent {
  if (!definition || definition.kind !== "sweatpants.agent-definition.v1") {
    fail("profile_incompatible", "A valid agent definition is required");
  }
  if (!profile || !["remote-executor", "standard-a2a", "sweatpants-peer"].includes(profile.kind)) {
    fail("profile_required", "Exactly one explicit serving profile is required");
  }
  verifyPublicAgentDeployment(profile.deployment);
  if (profile.kind === "remote-executor") {
    return compileRemote(definition, profile);
  }
  if (profile.kind === "standard-a2a") {
    return compileStandard(definition, profile);
  }
  return compilePeer(definition, profile);
}

function compileRemote(
  definition: AgentDefinition,
  profile: RemoteExecutorProfile,
): RemoteExecutorServedAgent {
  const selected = selectedBindings(definition, profile.bindings);
  if (Object.keys(selected).length === 0) {
    fail(
      "profile_incompatible",
      "Remote executor requires an explicit capability-to-entrypoint binding",
    );
  }
  const extension = createCallerAuthoritativeAgentExtension({
    protocolVersion: 1,
    manifestEndpoint: profile.deployment.manifestEndpoint,
    driverEndpoint: profile.deployment.driverEndpoint,
    programs: Object.entries(selected).map(([skillId, binding]) => ({
      skillId,
      program: pin(binding),
    })),
  });
  const card = agentCard(definition, profile.deployment, [extension]);
  const programs = uniqueProgramBindings(Object.values(selected));
  const registry = createDurableToolRegistry(programs.map((binding) => binding.program));
  const manifests = Object.freeze(
    Object.fromEntries(
      programs.map((binding) => [
        programKey(binding),
        createRemoteProgramManifestDocument(binding.program.manifest, {
          streamedRestore: profile.streamedRestore,
        }),
      ]),
    ),
  );
  return Object.freeze({
    posture: "remote-executor" as const,
    readiness: true,
    card,
    interfaces: cardInterfaces(card),
    extensions: [extension],
    definition,
    registry,
    manifests,
    selfCheck() {
      const parsed = parseCallerAuthoritativeExtensionParams(
        (extension as Record<string, Json>)["params"],
      );
      const checks = ["agent-card", "caller-authoritative-extension", "program-manifests"];
      const manifestPins = new Set(
        Object.values(manifests).map(
          (document) =>
            `${document.program.id}@${document.program.version}#${document.program.digest}`,
        ),
      );
      const ok = parsed.programs.every((mapping) =>
        manifestPins.has(
          `${mapping.program.id}@${mapping.program.version}#${mapping.program.digest}`,
        ),
      );
      return Object.freeze({ ok, checks: Object.freeze(checks) });
    },
  });
}

function compileStandard(
  definition: AgentDefinition,
  profile: StandardA2AProfile,
): StandardA2AServedAgent {
  const conversation = definition.bindings.conversation;
  if (!conversation) {
    fail("profile_incompatible", "standardA2A requires one conversation program");
  }
  preflightLocalEffects(uniqueProgramBindings([conversation]), profile.handlers);
  assertOptionalCapabilityBindings(definition, profile.capabilityBindings);
  const card = agentCard(definition, profile.deployment, []);
  const host = profile.host?.bind
    ? profile.host.bind({
        definition,
        card,
        deployment: profile.deployment,
        handlers: profile.handlers,
        historyProjection: profile.historyProjection ?? "accepted-context",
      })
    : profile.host;
  const readiness = Boolean(
    host &&
    "handle" in host &&
    typeof host.handle === "function" &&
    (!("readiness" in host) || host.readiness),
  );
  return Object.freeze({
    posture: "standard-a2a" as const,
    readiness,
    card,
    interfaces: cardInterfaces(card),
    extensions: Object.freeze([]),
    definition,
    descriptor: profile,
    ...(host ? { host } : {}),
    selfCheck() {
      return Object.freeze({
        ok: readiness,
        checks: Object.freeze([
          "agent-card",
          "conversation-program",
          "local-effect-routes",
          ...(readiness ? ["standard-task-host"] : []),
        ]),
      });
    },
  });
}

function compilePeer(
  definition: AgentDefinition,
  profile: SweatpantsPeerProfile,
): SweatpantsPeerServedAgent {
  const selected = selectedBindings(definition, profile.bindings);
  if (Object.keys(selected).length === 0) {
    fail("profile_incompatible", "Peer profile requires explicit capability entrypoints");
  }
  const requirements: Record<string, PeerEffectRequirementManifest> = {};
  const localHandlers: DurableEffectRegistration[] = [];
  for (const [skillId, binding] of Object.entries(selected)) {
    const requirementItems = Object.values(binding.program.manifest.effects).map(
      (definitionValue) => {
        const route = profile.effects[definitionValue.name];
        if (!route) {
          fail("effect_route_missing", "Peer effect route is missing");
        }
        if (route.route === "callee") {
          const handler = route.handler;
          if (!handler) {
            fail("effect_route_missing", "Callee-local peer effect handler is missing");
          }
          assertHandlerCompatible(definitionValue, handler);
          localHandlers.push(handler);
        }
        return {
          contract: definePeerEffectContract(definitionValue),
          availability:
            route.route === "callee"
              ? ("callee_local_only" as const)
              : ("caller_required" as const),
          required: route.required ?? true,
          allowedRoutes: [route.route] as PeerEffectRoute[],
        };
      },
    );
    requirements[skillId] = createPeerRequirementManifest({
      skillId,
      requirements: requirementItems,
      amendmentRequests: profile.amendmentRequests,
      releaseDigest: binding.program.manifest.digest,
    });
  }
  const extension = {
    uri: SWEATPANTS_PEER_PROFILE_URI,
    required: false,
    params: {
      protocolVersion: 1,
      delegatedEffectsVersion: 1,
      requirementManifestEndpoint: profile.deployment.requirementManifestEndpoint,
      delegatedEffectsEndpoint: profile.deployment.delegatedEffectsEndpoint,
      retention: profile.deployment.retention,
    },
  } as Json;
  const delegated = {
    uri: DELEGATED_EFFECTS_EXTENSION_URI,
    required: false,
    params: { protocolVersion: 1 },
  } as Json;
  const durable = {
    uri: DURABLE_INVOCATION_EXTENSION_URI,
    required: false,
    params: profile.deployment.durableInvocation,
  } as Json;
  const card = agentCard(definition, profile.deployment, [extension, delegated, durable]);
  return Object.freeze({
    posture: "sweatpants-peer" as const,
    readiness: true,
    card,
    interfaces: cardInterfaces(card),
    extensions: Object.freeze([extension, delegated, durable]),
    definition,
    requirements: Object.freeze(requirements),
    localHandlers: Object.freeze(uniqueRegistrations(localHandlers)),
    selfCheck() {
      try {
        for (const manifest of Object.values(requirements)) {
          parsePeerRequirementManifest(manifest);
        }
        parsePeerProfileParams((extension as Record<string, Json>)["params"]);
        parseDurableInvocationParams((durable as Record<string, Json>)["params"]);
        return Object.freeze({
          ok: true,
          checks: Object.freeze(["agent-card", "peer-requirements", "effect-routes"]),
        });
      } catch {
        return Object.freeze({
          ok: false,
          checks: Object.freeze(["agent-card", "peer-requirements", "effect-routes"]),
        });
      }
    },
  });
}

function agentCard(
  definition: AgentDefinition,
  deployment: PublicAgentDeployment,
  extensions: readonly Json[],
): Json {
  const manifest = definition.manifest;
  const skills = Object.values(manifest.advertisedCapabilities).map(capabilitySkill);
  const unsigned = canonicalSnapshot({
    name: manifest.identity.name,
    description: manifest.description,
    version: manifest.identity.version,
    // Required by the pinned A2A Inspector's current AgentCard contract.
    url: deployment.interfaceUrl,
    preferredTransport: deployment.protocolBinding ?? "HTTP+JSON",
    supportedInterfaces: [
      {
        url: deployment.interfaceUrl,
        protocolBinding: deployment.protocolBinding ?? "HTTP+JSON",
        protocolVersion: "1.0",
      },
    ],
    defaultInputModes: [...(deployment.defaultInputModes ?? ["text/plain", "application/json"])],
    defaultOutputModes: [...(deployment.defaultOutputModes ?? ["text/plain", "application/json"])],
    capabilities: { streaming: true, extensions },
    skills,
    ...(deployment.securitySchemes !== undefined
      ? { securitySchemes: deployment.securitySchemes }
      : {}),
    ...(deployment.securityRequirements !== undefined
      ? {
          securityRequirements: deployment.securityRequirements,
          security: deployment.securityRequirements,
        }
      : {}),
  } as unknown as Json).value;
  if (!deployment.cardSigner) {
    return unsigned;
  }
  const signature = deployment.cardSigner.sign(unsigned);
  if (
    !signature.protected ||
    !signature.signature ||
    signature.protected.length > 16_384 ||
    signature.signature.length > 16_384
  ) {
    fail("profile_incompatible", "Agent Card signer returned an invalid JWS signature");
  }
  return canonicalSnapshot({
    ...(unsigned as Record<string, Json>),
    signatures: [signature],
  } as unknown as Json).value;
}
function capabilitySkill(capability: AdvertisedCapabilityV1): Json {
  return {
    id: capability.id,
    name: capability.name,
    description: capability.description,
    tags: [...capability.tags],
    examples: [...capability.examples],
    inputModes: [...capability.inputModes],
    outputModes: [...capability.outputModes],
  };
}
function selectedBindings(
  definition: AgentDefinition,
  mappings: Readonly<Record<string, string>>,
): Record<string, AgentProgramBinding> {
  const selected: Record<string, AgentProgramBinding> = {};
  for (const [capabilityId, entrypoint] of Object.entries(mappings)) {
    if (!definition.manifest.advertisedCapabilities[capabilityId]) {
      fail("profile_incompatible", "Profile binds an unknown capability");
    }
    const binding = definition.bindings.programs[entrypoint];
    if (!binding) {
      fail("profile_incompatible", "Profile binds an unknown exact entrypoint");
    }
    selected[capabilityId] = binding;
  }
  return selected;
}
function assertOptionalCapabilityBindings(
  definition: AgentDefinition,
  mappings: Readonly<Record<string, string>>,
): void {
  selectedBindings(definition, mappings);
}
function uniqueProgramBindings(bindings: readonly AgentProgramBinding[]): AgentProgramBinding[] {
  const map = new Map<string, AgentProgramBinding>();
  const pending = [...bindings];
  while (pending.length > 0) {
    const binding = pending.shift()!;
    const key = programKey(binding);
    if (map.has(key)) {
      continue;
    }
    map.set(key, binding);
    const authored = binding.program as typeof binding.program & {
      readonly childPrograms?: Readonly<Record<string, AgentProgramBinding>>;
    };
    if (authored.childPrograms) {
      pending.push(...Object.values(authored.childPrograms));
    }
  }
  return [...map.values()];
}
function preflightLocalEffects(
  bindings: readonly AgentProgramBinding[],
  handlers: readonly DurableEffectRegistration[],
): void {
  const map = new Map(
    handlers.map((handler) => [
      `${handler.definition.name}@${handler.definition.version}`,
      handler,
    ]),
  );
  for (const binding of bindings) {
    for (const definition of Object.values(binding.program.manifest.effects)) {
      const handler = map.get(`${definition.name}@${definition.version}`);
      if (!handler) {
        fail("effect_route_missing", "Standard profile effect handler is missing");
      }
      assertHandlerCompatible(definition, handler);
    }
  }
}
function assertHandlerCompatible(
  definition: EffectDefinition<Json, Json, Json>,
  handler: DurableEffectRegistration,
): void {
  if (
    canonicalJson(definition) !== canonicalJson(handler.definition) ||
    handler.satisfies.mode !== definition.retrySafety.mode ||
    (definition.retrySafety.mode === "idempotent" &&
      (handler.satisfies.mode !== "idempotent" ||
        handler.satisfies.mechanism !== definition.retrySafety.mechanism))
  ) {
    fail("effect_route_incompatible", "Effect route exact contract or retry safety differs");
  }
}
function uniqueRegistrations(values: DurableEffectRegistration[]): DurableEffectRegistration[] {
  const map = new Map(
    values.map((value) => [`${value.definition.name}@${value.definition.version}`, value]),
  );
  return [...map.values()];
}
function verifyPublicAgentDeployment(value: PublicAgentDeployment): void {
  if (!value || typeof value.interfaceUrl !== "string") {
    fail("profile_incompatible", "Profile deployment endpoint is missing");
  }
  if (!URL.canParse(value.interfaceUrl)) {
    fail("profile_incompatible", "Profile deployment endpoint is invalid");
  }
}
function pin(binding: AgentProgramBinding) {
  return {
    id: binding.program.manifest.programId,
    version: binding.program.manifest.version,
    digest: binding.program.manifest.digest,
  };
}
function programKey(binding: AgentProgramBinding) {
  const value = pin(binding);
  return `${value.id}@${value.version}#${value.digest}`;
}
function cardInterfaces(card: Json): readonly Json[] {
  return Object.freeze(
    Array.isArray((card as Record<string, Json>)["supportedInterfaces"])
      ? [...((card as Record<string, Json>)["supportedInterfaces"] as Json[])]
      : [],
  );
}
function fail(code: AgentFacadeErrorCode, message: string): never {
  throw new AgentFacadeError(code, message);
}

// Documented server-lane re-export without creating another implementation.
export { defineAgent };
export type { BoundStandardA2AHost, StandardA2AHostPort } from "./standard-a2a-host.ts";
