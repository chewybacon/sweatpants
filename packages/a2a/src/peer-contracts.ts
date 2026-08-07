import {
  durableEffectRuntimeSchemas,
  type DurableEffectRegistry,
  type EffectDefinition,
} from "@sweatpants/durable-effects";

import { CrankError } from "@sweatpants/durable-execution";
import { assertEffectDefinition } from "@sweatpants/durable-effects/authoring";
import {
  canonicalJson,
  canonicalSnapshot,
  failure,
  parser,
  sha256,
  success,
  type Json,
  type Parser,
} from "@sweatpants/foundation";
import { z } from "zod";

const peerDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const requirementManifestShapeSchema = z.strictObject({
  protocolVersion: z.literal(1),
  skillId: z.string().min(1),
  requirements: z.array(z.json()),
  amendmentRequests: z.boolean(),
  releaseDigest: peerDigestSchema,
  manifestDigest: peerDigestSchema,
});
const peerContractShapeSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  inputSchema: z.json(),
  outputSchema: z.json(),
  retrySafety: z.json(),
  contractDigest: peerDigestSchema,
  cancellation: z.strictObject({ partialSchema: z.json() }).optional(),
});
const requirementShapeSchema = z.strictObject({
  contract: z.json(),
  availability: z.enum([
    "callee_local_only",
    "caller_required",
    "caller_optional",
    "route_negotiable",
  ]),
  required: z.boolean(),
  allowedRoutes: z.array(z.enum(["callee", "caller", "denied"])),
  defaultConstraints: z.json().optional(),
  defaultBudget: z.json().optional(),
});
const requirementIdentityParser = parser(
  z.strictObject({ skillId: z.string().min(1), releaseDigest: peerDigestSchema }),
);
const requirementManifestStructureParser = parser(requirementManifestShapeSchema);
const requirementStructureParser = parser(requirementShapeSchema);
const peerContractStructureParser = parser(peerContractShapeSchema);

import type {
  PeerEffectContract,
  PeerEffectOffer,
  PeerEffectRequirement,
  PeerEffectRequirementManifest,
  PeerGrant,
  PeerGrantSet,
  PeerOffer,
} from "./peer-types.ts";

const CONTRACT_DOMAIN = "sweatpants.peer.effect-contract.v1";
const MANIFEST_DOMAIN = "sweatpants.peer.requirement-manifest.v1";
const GRANT_DOMAIN = "sweatpants.peer.grant-set.v1";

export const peerEffectContractParser: Parser<PeerEffectContract> =
  peerContractStructureParser.andThen((value) => semanticParse(() => normalizeContract(value)));
const peerEffectRequirementParser: Parser<PeerEffectRequirement> =
  requirementStructureParser.andThen((value) => semanticParse(() => normalizeRequirement(value)));
export const peerRequirementManifestParser: Parser<PeerEffectRequirementManifest> =
  requirementManifestStructureParser.andThen((value) =>
    semanticParse(() => normalizeRequirementManifest(value)),
  );

export function definePeerEffectContract(
  definition: EffectDefinition<Json, Json, Json>,
): PeerEffectContract {
  assertEffectDefinition(definition);
  const body = {
    name: definition.name,
    version: definition.version,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    ...(definition.cancellation
      ? { cancellation: { partialSchema: definition.cancellation.partialSchema } }
      : {}),
    retrySafety: definition.retrySafety,
  };
  return Object.freeze({
    ...body,
    contractDigest: sha256(canonicalJson({ domain: CONTRACT_DOMAIN, contract: body })),
  });
}

export function parsePeerRequirementManifest(value: unknown): PeerEffectRequirementManifest {
  const parsed = peerRequirementManifestParser.parse(value);
  if (!parsed.ok) {
    throw new CrankError(
      "peer_manifest_invalid",
      parsed.issues[0]?.message ?? "Invalid closed peer requirement manifest",
    );
  }
  return parsed.value;
}

function normalizeRequirementManifest(
  manifest: z.output<typeof requirementManifestShapeSchema>,
): PeerEffectRequirementManifest {
  const names = new Set<string>();
  const requirements = manifest.requirements.map((requirement) => {
    const parsed = parseRequirement(requirement);
    if (names.has(parsed.contract.name)) {
      throw new CrankError(
        "peer_manifest_invalid",
        "One requirement set may not contain multiple versions of one effect name",
      );
    }
    names.add(parsed.contract.name);
    return parsed;
  });
  const body = {
    protocolVersion: 1 as const,
    skillId: manifest.skillId,
    requirements: [...requirements].sort(compareRequirements),
    amendmentRequests: manifest.amendmentRequests,
    releaseDigest: manifest.releaseDigest,
  };
  const computed = sha256(canonicalJson({ domain: MANIFEST_DOMAIN, manifest: body }));
  if (computed !== manifest.manifestDigest) {
    throw new CrankError("peer_manifest_invalid", "Peer requirement manifest digest mismatch");
  }
  return Object.freeze({ ...body, manifestDigest: computed });
}

export function createPeerRequirementManifest(input: {
  skillId: string;
  requirements: PeerEffectRequirement[];
  amendmentRequests: boolean;
  releaseDigest: string;
}): PeerEffectRequirementManifest {
  const names = new Set<string>();
  const requirements = input.requirements.map((requirement) => {
    const parsed = parseRequirement(requirement);
    if (names.has(parsed.contract.name)) {
      throw new CrankError("peer_manifest_invalid", "Duplicate symbolic effect requirement");
    }
    names.add(parsed.contract.name);
    return parsed;
  });
  if (
    !requirementIdentityParser.parse({
      skillId: input.skillId,
      releaseDigest: input.releaseDigest,
    }).ok
  ) {
    throw new CrankError("peer_manifest_invalid", "Invalid peer requirement identity");
  }
  const body = {
    protocolVersion: 1 as const,
    skillId: input.skillId,
    requirements: [...requirements].sort(compareRequirements),
    amendmentRequests: input.amendmentRequests,
    releaseDigest: input.releaseDigest,
  };
  return Object.freeze({
    ...body,
    manifestDigest: sha256(canonicalJson({ domain: MANIFEST_DOMAIN, manifest: body })),
  });
}

export function buildPeerOffer(input: {
  manifest: PeerEffectRequirementManifest;
  routes: Readonly<Record<string, PeerEffectOffer>>;
  effectRegistry: DurableEffectRegistry;
  amendmentRequests?: boolean;
  lineage?: string[];
}): PeerOffer {
  const offers: PeerEffectOffer[] = [];
  for (const requirement of input.manifest.requirements) {
    const offered = input.routes[requirement.contract.name];
    if (!offered) {
      if (requirement.required) {
        throw new CrankError(
          "peer_required_effect_unavailable",
          `No route offered for required effect ${requirement.contract.name}`,
        );
      }
      continue;
    }
    if (offered.contractDigest !== requirement.contract.contractDigest) {
      throw new CrankError(
        "peer_effect_contract_mismatch",
        "Offered effect contract digest differs",
      );
    }
    if (!requirement.allowedRoutes.includes(offered.route)) {
      throw new CrankError("peer_effect_route_denied", "Offered effect route is not permitted");
    }
    if (offered.route === "caller") {
      preflightCallerContract(requirement.contract, input.effectRegistry);
    }
    if (offered.route === "denied" && requirement.required) {
      throw new CrankError("peer_required_effect_unavailable", "Required effect may not be denied");
    }
    verifyPeerDelegation(offered);
    offers.push(snapshotOffer(offered));
  }
  return Object.freeze({
    protocolVersion: 1,
    skillId: input.manifest.skillId,
    requirementManifestDigest: input.manifest.manifestDigest,
    effects: offers.sort(compareOffers),
    amendmentRequests: input.amendmentRequests ?? false,
    ...(input.lineage ? { lineage: [...input.lineage] } : {}),
  });
}

export function negotiatePeerGrantSet(input: {
  manifest: PeerEffectRequirementManifest;
  offer: PeerOffer;
  callerIdentity: string;
  calleeIdentity: string;
  invocationId: string;
  expiresAt: string;
  version?: number;
  previousDigest?: string;
}): PeerGrantSet {
  if (input.offer.requirementManifestDigest !== input.manifest.manifestDigest) {
    throw new CrankError("peer_grant_mismatch", "Offer targets another requirement manifest");
  }
  if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) {
    throw new CrankError("peer_grant_expired", "Grant expiry must be in the future");
  }
  const grants: PeerGrant[] = [];
  for (const requirement of input.manifest.requirements) {
    const offered = input.offer.effects.find(
      (candidate) => candidate.contractDigest === requirement.contract.contractDigest,
    );
    if (!offered) {
      if (requirement.required) {
        throw new CrankError(
          "peer_required_effect_unavailable",
          "Required effect is absent from offer",
        );
      }
      continue;
    }
    if (!requirement.allowedRoutes.includes(offered.route)) {
      throw new CrankError("peer_effect_route_denied", "Grant route is not allowed");
    }
    const version = input.version ?? 1;
    const grantBody = {
      grantVersion: version,
      contract: requirement.contract,
      route: offered.route,
      ...(offered.constraints !== undefined ? { constraints: offered.constraints } : {}),
      ...(offered.budget !== undefined ? { budget: offered.budget } : {}),
      expiresAt: input.expiresAt,
      delegation: offered.delegation,
      callerIdentity: input.callerIdentity,
      calleeIdentity: input.calleeIdentity,
      invocationId: input.invocationId,
    };
    grants.push({
      grantId: `grant_${sha256(canonicalJson(grantBody)).slice(0, 40)}`,
      ...grantBody,
    });
  }
  return finalizeGrantSet({
    version: input.version ?? 1,
    ...(input.previousDigest ? { previousDigest: input.previousDigest } : {}),
    requirementManifestDigest: input.manifest.manifestDigest,
    grants,
    amendmentRequests: input.offer.amendmentRequests && input.manifest.amendmentRequests,
  });
}

export function finalizeGrantSet(
  input: Omit<PeerGrantSet, "protocolVersion" | "digest">,
): PeerGrantSet {
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new CrankError("peer_grant_invalid", "Grant version must be positive");
  }
  if (input.version > 1 && !input.previousDigest) {
    throw new CrankError("peer_grant_invalid", "Grant amendment must link its previous digest");
  }
  const body = {
    protocolVersion: 1 as const,
    version: input.version,
    ...(input.previousDigest ? { previousDigest: input.previousDigest } : {}),
    requirementManifestDigest: input.requirementManifestDigest,
    grants: [...input.grants].sort(compareGrants).map(snapshotGrant),
    amendmentRequests: input.amendmentRequests,
  };
  return Object.freeze({
    ...body,
    digest: sha256(canonicalJson({ domain: GRANT_DOMAIN, grantSet: body })),
  });
}

export function peerContractAsEffectDefinition(
  contract: PeerEffectContract,
): EffectDefinition<Json, Json, Json> {
  const definition: EffectDefinition<Json, Json, Json> = {
    name: contract.name,
    version: contract.version,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    ...(contract.cancellation
      ? { cancellation: { partialSchema: contract.cancellation.partialSchema } }
      : {}),
    retrySafety: contract.retrySafety,
  };
  assertEffectDefinition(definition);
  if (definePeerEffectContract(definition).contractDigest !== contract.contractDigest) {
    throw new CrankError("peer_effect_contract_mismatch", "Effect whole-contract digest mismatch");
  }
  return definition;
}

function preflightCallerContract(
  contract: PeerEffectContract,
  registry: DurableEffectRegistry,
): void {
  const registration = registry.get(`${contract.name}@${contract.version}`);
  if (!registration) {
    throw new CrankError("peer_required_effect_unavailable", "Caller effect handler is missing");
  }
  if (
    definePeerEffectContract(registration.definition).contractDigest !== contract.contractDigest
  ) {
    throw new CrankError("peer_effect_contract_mismatch", "Caller effect handler contract differs");
  }
  const schemas = durableEffectRuntimeSchemas(registration);
  if (!schemas?.input || !schemas.output) {
    throw new CrankError("peer_effect_contract_mismatch", "Caller runtime validators are missing");
  }
  if (
    registration.satisfies.mode !== contract.retrySafety.mode ||
    (contract.retrySafety.mode === "idempotent" &&
      (registration.satisfies.mode !== "idempotent" ||
        registration.satisfies.mechanism !== contract.retrySafety.mechanism))
  ) {
    throw new CrankError("peer_effect_contract_mismatch", "Caller retry safety differs");
  }
}
function parseRequirement(value: unknown): PeerEffectRequirement {
  const parsed = peerEffectRequirementParser.parse(value);
  if (!parsed.ok) {
    const issue = parsed.issues[0];
    throw new CrankError(
      issue?.code?.startsWith("peer_") ? issue.code : "peer_manifest_invalid",
      issue?.message ?? "Invalid peer effect requirement",
    );
  }
  return parsed.value;
}
function normalizeRequirement(
  requirement: z.output<typeof requirementShapeSchema>,
): PeerEffectRequirement {
  const contract = requireContract(requirement.contract);
  return Object.freeze({
    contract,
    availability: requirement.availability,
    required: requirement.required,
    allowedRoutes: [...new Set(requirement.allowedRoutes)],
    ...(requirement.defaultConstraints === undefined
      ? {}
      : { defaultConstraints: requirement.defaultConstraints }),
    ...(requirement.defaultBudget === undefined
      ? {}
      : { defaultBudget: requirement.defaultBudget }),
  });
}
function requireContract(value: unknown): PeerEffectContract {
  const parsed = peerEffectContractParser.parse(value);
  if (!parsed.ok) {
    const issue = parsed.issues[0];
    throw new CrankError(
      issue?.code?.startsWith("peer_") ? issue.code : "peer_manifest_invalid",
      issue?.message ?? "Invalid peer effect contract",
    );
  }
  return parsed.value;
}
function normalizeContract(value: z.output<typeof peerContractShapeSchema>): PeerEffectContract {
  const definition = peerContractAsEffectDefinition(value as unknown as PeerEffectContract);
  return definePeerEffectContract(definition);
}
function snapshotOffer(value: PeerEffectOffer): PeerEffectOffer {
  return canonicalSnapshot(value).value as PeerEffectOffer;
}
function snapshotGrant(value: PeerGrant): PeerGrant {
  peerContractAsEffectDefinition(value.contract);
  return canonicalSnapshot(value).value as PeerGrant;
}
function verifyPeerDelegation(offer: PeerEffectOffer): void {
  if (offer.delegation.mode === "none") {
    return;
  }
  if (
    !Number.isSafeInteger(offer.delegation.maxDepth) ||
    offer.delegation.maxDepth < 1 ||
    offer.delegation.maxDepth > 8 ||
    offer.delegation.allowedAgents.length === 0 ||
    offer.delegation.allowedContractDigests.length === 0
  ) {
    throw new CrankError("peer_delegation_invalid", "Invalid bounded transitive delegation");
  }
}
function compareRequirements(left: PeerEffectRequirement, right: PeerEffectRequirement): number {
  return compareContracts(left.contract, right.contract);
}
function compareOffers(left: PeerEffectOffer, right: PeerEffectOffer): number {
  return left.contractDigest.localeCompare(right.contractDigest);
}
function compareGrants(left: PeerGrant, right: PeerGrant): number {
  return compareContracts(left.contract, right.contract);
}
function compareContracts(left: PeerEffectContract, right: PeerEffectContract): number {
  return (
    left.name.localeCompare(right.name) ||
    left.version.localeCompare(right.version) ||
    left.contractDigest.localeCompare(right.contractDigest)
  );
}
function semanticParse<T>(operation: () => T) {
  try {
    return success(operation());
  } catch (error) {
    if (error instanceof CrankError) {
      return failure<T>({ path: [], message: error.message, code: error.code });
    }
    throw error;
  }
}
