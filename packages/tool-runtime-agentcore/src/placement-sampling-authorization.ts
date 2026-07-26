import type { Operation } from "effection";
import {
  CrankError,
  canonicalSnapshot,
  signPrivateAuthorityToken,
  verifyPrivateAuthorityToken,
  type CapabilityKeyring,
  type Json,
} from "@sweatpants/session-contract";

import type {
  PlacementSamplingAuthorizationIssuer,
  RemoteSampleIdentity,
} from "./placement-model-sampler.ts";

const PURPOSE = "sweatpants.agentcore-model-sampling.v1";
const PERMISSIONS = ["sample:attach", "sample:read", "sample:cancel"] as const;

export interface PlacementSamplingAuthorizationClaims {
  readonly version: 1;
  readonly issuer: string;
  readonly keyId: string;
  readonly protocolVersion: 1;
  readonly identity: RemoteSampleIdentity;
  readonly attemptId: string;
  readonly releaseId: string;
  readonly requestDigest: string;
  readonly effectContractDigest: string;
  readonly classifications: readonly Json[];
  readonly permissions: readonly ["sample:attach", "sample:read", "sample:cancel"];
  readonly expiresAt: string;
}

export function createPlacementSamplingAuthorizationIssuer(options: {
  readonly keyring: CapabilityKeyring;
  readonly now?: () => number;
  readonly ttlMs?: number;
}): PlacementSamplingAuthorizationIssuer {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 5 * 60_000) {
    throw new CrankError("invalid_manifest", "Sampling authorization TTL must be 1-300000ms");
  }
  return Object.freeze({
    *issue(
      request: Parameters<PlacementSamplingAuthorizationIssuer["issue"]>[0],
    ): Operation<string> {
      const claims: PlacementSamplingAuthorizationClaims = {
        version: 1,
        issuer: options.keyring.issuer,
        keyId: options.keyring.activeKeyId,
        protocolVersion: 1,
        identity: request.identity,
        attemptId: request.attemptId,
        releaseId: request.releaseId,
        requestDigest: request.requestDigest,
        effectContractDigest: request.effectContractDigest,
        classifications: [...request.classifications],
        permissions: PERMISSIONS,
        expiresAt: new Date(now() + ttlMs).toISOString(),
      };
      return signPrivateAuthorityToken(PURPOSE, claims, options.keyring);
    },
  });
}

export function verifyPlacementSamplingAuthorization(options: {
  readonly token: string;
  readonly keyring: CapabilityKeyring;
  readonly expected: {
    readonly identity: RemoteSampleIdentity;
    readonly releaseId: string;
    readonly requestDigest: string;
    readonly effectContractDigest: string;
    readonly classifications: readonly Json[];
  };
  readonly now?: () => number;
}): PlacementSamplingAuthorizationClaims {
  let value: unknown;
  try {
    value = verifyPrivateAuthorityToken(options.token, PURPOSE, options.keyring);
  } catch {
    throw unauthorized();
  }
  if (!isRecord(value)) {
    throw unauthorized();
  }
  const keys = [
    "version",
    "issuer",
    "keyId",
    "protocolVersion",
    "identity",
    "attemptId",
    "releaseId",
    "requestDigest",
    "effectContractDigest",
    "classifications",
    "permissions",
    "expiresAt",
  ];
  if (Object.keys(value).length !== keys.length || !keys.every((key) => key in value)) {
    throw unauthorized();
  }
  const claims = value as unknown as PlacementSamplingAuthorizationClaims;
  const now = options.now ?? Date.now;
  if (
    claims.version !== 1 ||
    claims.protocolVersion !== 1 ||
    claims.issuer !== options.keyring.issuer ||
    typeof claims.keyId !== "string" ||
    typeof claims.attemptId !== "string" ||
    claims.attemptId.length === 0 ||
    claims.releaseId !== options.expected.releaseId ||
    claims.requestDigest !== options.expected.requestDigest ||
    claims.effectContractDigest !== options.expected.effectContractDigest ||
    Date.parse(claims.expiresAt) <= now() ||
    canonicalSnapshot(claims.identity as unknown as Json).sha !==
      canonicalSnapshot(options.expected.identity as unknown as Json).sha ||
    canonicalSnapshot(claims.classifications as Json).sha !==
      canonicalSnapshot(options.expected.classifications as Json).sha ||
    canonicalSnapshot(claims.permissions as unknown as Json).sha !==
      canonicalSnapshot(PERMISSIONS as unknown as Json).sha
  ) {
    throw unauthorized();
  }
  return claims;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function unauthorized(): CrankError {
  return new CrankError("remote_sample_unauthorized", "Remote sample authorization failed");
}
