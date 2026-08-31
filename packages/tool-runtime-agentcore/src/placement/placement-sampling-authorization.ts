import { CrankError } from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import {
  signPrivateAuthorityToken,
  verifyPrivateAuthorityToken,
  type CapabilityKeyring,
} from "@sweatpants/journal-authority";
import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import { z } from "zod";

import type {
  PlacementSamplingAuthorizationIssuer,
  RemoteSampleIdentity,
} from "./placement-model-sampler.ts";

const PURPOSE = "sweatpants.agentcore-model-sampling.v1";
const PERMISSIONS = ["sample:attach", "sample:read", "sample:cancel"] as const;
const samplingAuthorizationClaimsSchema = z.strictObject({
  version: z.literal(1),
  issuer: z.string().min(1).max(4_096),
  keyId: z.string().min(1).max(4_096),
  protocolVersion: z.literal(1),
  identity: z.strictObject({
    journalId: z.string().min(1).max(4_096),
    journalIncarnation: z.string().min(1).max(4_096),
    sessionId: z.string().min(1).max(4_096),
    taskId: z.string().min(1).max(4_096),
    pullId: z.string().min(1).max(4_096),
  }),
  attemptId: z.string().min(1).max(4_096),
  releaseId: z.string().min(1).max(4_096),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  effectContractDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  classifications: z.array(z.json()).max(4_096),
  permissions: z.tuple([
    z.literal("sample:attach"),
    z.literal("sample:read"),
    z.literal("sample:cancel"),
  ]),
  expiresAt: z.string().min(1).max(128),
});

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
  const parsed = samplingAuthorizationClaimsSchema.safeParse(value);
  if (!parsed.success) {
    throw unauthorized();
  }
  const claims = parsed.data;
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

function unauthorized(): CrankError {
  return new CrankError("remote_sample_unauthorized", "Remote sample authorization failed");
}
