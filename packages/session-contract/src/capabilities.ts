import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { canonicalJson } from "./canonical.ts";
import { CrankError } from "./types.ts";
import type {
  CapabilityClaims,
  ProgramExecutionCapabilityClaims,
  ResolutionCapabilityClaims,
} from "./durable-types.ts";

const encoder = new TextEncoder();

export type CapabilityKey = {
  keyId: string;
  secret: Uint8Array | string;
  status?: "active" | "verify_only" | "retired";
};

export interface CapabilityKeyring {
  issuer: string;
  activeKeyId: string;
  keys: ReadonlyMap<string, { secret: Uint8Array; status: "active" | "verify_only" | "retired" }>;
}

export function createCapabilityKeyring(
  issuer: string,
  keys: readonly CapabilityKey[],
  activeKeyId?: string,
): CapabilityKeyring {
  if (!issuer) {
    throw new CrankError("invalid_manifest", "Capability issuer must be non-empty");
  }
  if (keys.length === 0) {
    throw new CrankError("invalid_manifest", "At least one capability key is required");
  }
  const normalized = new Map<
    string,
    { secret: Uint8Array; status: "active" | "verify_only" | "retired" }
  >();
  for (const key of keys) {
    if (!key.keyId || normalized.has(key.keyId)) {
      throw new CrankError("invalid_manifest", "Capability key IDs must be unique and non-empty");
    }
    const secret =
      typeof key.secret === "string" ? encoder.encode(key.secret) : new Uint8Array(key.secret);
    if (secret.byteLength < 32) {
      throw new CrankError(
        "invalid_manifest",
        `Capability key ${key.keyId} must contain at least 256 bits`,
      );
    }
    normalized.set(key.keyId, { secret, status: key.status ?? "active" });
  }
  const selected = activeKeyId ?? keys.find((key) => (key.status ?? "active") === "active")?.keyId;
  if (!selected || normalized.get(selected)?.status !== "active") {
    throw new CrankError("invalid_manifest", "An active signing key is required");
  }
  return Object.freeze({ issuer, activeKeyId: selected, keys: normalized });
}

type UnsignedProgramCapabilityClaims = Omit<
  ProgramExecutionCapabilityClaims,
  "version" | "issuer" | "keyId"
>;
type UnsignedResolutionCapabilityClaims = Omit<
  ResolutionCapabilityClaims,
  "version" | "issuer" | "keyId"
>;
type UnsignedCapabilityClaims =
  | UnsignedProgramCapabilityClaims
  | UnsignedResolutionCapabilityClaims;

export function signCapability(
  claims: UnsignedCapabilityClaims,
  keyring: CapabilityKeyring,
): string {
  const keyId = keyring.activeKeyId;
  const key = keyring.keys.get(keyId);
  if (!key || key.status !== "active") {
    throw new CrankError("invalid_resolution_capability", "Signing key is not active");
  }
  const complete: CapabilityClaims = {
    ...claims,
    version: 1,
    issuer: keyring.issuer,
    keyId,
  };
  validateClaims(complete);
  const first = "v1";
  const second = base64url(encoder.encode(keyId));
  const third = base64url(encoder.encode(canonicalJson(complete)));
  const signingInput = `${first}.${second}.${third}`;
  const signature = hmac(sha256, key.secret, encoder.encode(signingInput));
  return `${signingInput}.${base64url(signature)}`;
}

export function verifyCapability(token: string, keyring: CapabilityKeyring): CapabilityClaims {
  try {
    const [version, keyPart, claimsPart, signaturePart, ...extraParts] = token.split(".");
    if (
      version !== "v1" ||
      keyPart === undefined ||
      claimsPart === undefined ||
      signaturePart === undefined ||
      extraParts.length > 0
    ) {
      throw invalid();
    }
    const keyId = new TextDecoder().decode(fromBase64url(keyPart));
    const key = keyring.keys.get(keyId);
    if (!key || key.status === "retired") {
      throw invalid();
    }
    const expected = hmac(
      sha256,
      key.secret,
      encoder.encode([version, keyPart, claimsPart].join(".")),
    );
    const actual = fromBase64url(signaturePart);
    if (!equalBytes(expected, actual)) {
      throw invalid();
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(fromBase64url(claimsPart));
    const claims: unknown = JSON.parse(decoded);
    validateClaims(claims);
    if (canonicalJson(claims) !== decoded) {
      throw invalid();
    }
    if (claims.keyId !== keyId || claims.issuer !== keyring.issuer) {
      throw invalid();
    }
    return claims;
  } catch (error) {
    if (error instanceof CrankError) {
      throw error;
    }
    throw invalid();
  }
}

export function verifyProgramCapability(
  token: string,
  keyring: CapabilityKeyring,
  expected: {
    audience: string;
    journalId: string;
    journalIncarnation: string;
    sessionId: string;
    taskId: string;
    executionEpoch: number;
    attachmentId?: string;
  },
): ProgramExecutionCapabilityClaims {
  const claims = verifyCapability(token, keyring);
  if (!isProgramClaims(claims)) {
    throw invalid();
  }
  if (claims.audience !== expected.audience) {
    throw new CrankError("wrong_audience");
  }
  if (
    claims.journalId !== expected.journalId ||
    claims.journalIncarnation !== expected.journalIncarnation ||
    claims.sessionId !== expected.sessionId ||
    claims.taskId !== expected.taskId ||
    claims.executionEpoch !== expected.executionEpoch ||
    (expected.attachmentId !== undefined && claims.attachmentId !== expected.attachmentId)
  ) {
    throw new CrankError("stale_program_capability");
  }
  return claims;
}

export function verifyResolutionCapability(
  token: string,
  keyring: CapabilityKeyring,
  audience: string,
): ResolutionCapabilityClaims {
  const claims = verifyCapability(token, keyring);
  if (!isResolutionClaims(claims)) {
    throw invalid();
  }
  if (claims.audience !== audience) {
    throw new CrankError("wrong_audience");
  }
  return claims;
}

export function isProgramClaims(
  claims: CapabilityClaims,
): claims is ProgramExecutionCapabilityClaims {
  return (
    Array.isArray(claims.permissions) &&
    claims.permissions.length === 2 &&
    claims.permissions[0] === "propose" &&
    claims.permissions[1] === "complete"
  );
}

export function isResolutionClaims(claims: CapabilityClaims): claims is ResolutionCapabilityClaims {
  return (
    Array.isArray(claims.permissions) &&
    claims.permissions.length === 1 &&
    claims.permissions[0] === "resolve"
  );
}

function validateClaims(claims: unknown): asserts claims is CapabilityClaims {
  if (!isUnknownRecord(claims) || claims["version"] !== 1) {
    throw invalid();
  }
  requireStringFields(claims, [
    "issuer",
    "keyId",
    "journalId",
    "journalIncarnation",
    "sessionId",
    "taskId",
    "audience",
    "nonce",
  ]);
  const permissions = claims["permissions"];
  if (
    Array.isArray(permissions) &&
    permissions.length === 2 &&
    permissions[0] === "propose" &&
    permissions[1] === "complete"
  ) {
    requireStringFields(claims, ["programId", "programVersion", "programDigest", "attachmentId"]);
    const executionEpoch = claims["executionEpoch"];
    if (
      typeof executionEpoch !== "number" ||
      !Number.isSafeInteger(executionEpoch) ||
      executionEpoch < 0
    ) {
      throw invalid();
    }
    return;
  }
  if (Array.isArray(permissions) && permissions.length === 1 && permissions[0] === "resolve") {
    requireStringFields(claims, ["pullId", "descriptorDigest", "resultSchemaDigest", "attemptId"]);
    const maxOutcomeBytes = claims["maxOutcomeBytes"];
    if (
      typeof maxOutcomeBytes !== "number" ||
      !Number.isSafeInteger(maxOutcomeBytes) ||
      maxOutcomeBytes < 0
    ) {
      throw invalid();
    }
    return;
  }
  throw invalid();
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireStringFields(value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw invalid();
    }
  }
}

function invalid(): CrankError {
  return new CrankError("invalid_resolution_capability", "Invalid capability token");
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw invalid();
  }
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (const [index, byte] of left.entries()) {
    const other = right[index];
    if (other === undefined) {
      return false;
    }
    difference |= byte ^ other;
  }
  return difference === 0;
}
