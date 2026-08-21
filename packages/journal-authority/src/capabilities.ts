import { CrankError } from "@sweatpants/durable-execution";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { canonicalJson } from "@sweatpants/foundation";
import { parser } from "@sweatpants/foundation/parser";
import { z } from "zod";

import type {
  CapabilityClaims,
  ProgramExecutionCapabilityClaims,
  ResolutionCapabilityClaims,
} from "./authority-types.ts";

const encoder = new TextEncoder();

/** Signing-key material supplied at composition; secrets are copied on ingress. */
export type CapabilityKey = {
  keyId: string;
  secret: Uint8Array | string;
  status?: "active" | "verify_only" | "retired";
};

/** Immutable capability verification policy with one active signing key. */
export interface CapabilityKeyring {
  readonly issuer: string;
  readonly activeKeyId: string;
}

type KeyringState = ReadonlyMap<
  string,
  { readonly secret: Uint8Array; readonly status: "active" | "verify_only" | "retired" }
>;

const keyringStates = new WeakMap<CapabilityKeyring, KeyringState>();

/** Parses key configuration, enforces unique IDs and 256-bit minimum secrets. */
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
  const keyring: CapabilityKeyring = Object.freeze({ issuer, activeKeyId: selected });
  keyringStates.set(keyring, normalized);
  return keyring;
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

/** Signs exact, canonical capability claims; rejects extra runtime fields. */
export function signCapability(
  claims: UnsignedCapabilityClaims,
  keyring: CapabilityKeyring,
): string {
  const keyId = keyring.activeKeyId;
  const key = keyringState(keyring).get(keyId);
  if (!key || key.status !== "active") {
    throw new CrankError("invalid_resolution_capability", "Signing key is not active");
  }
  const complete: CapabilityClaims = {
    ...claims,
    version: 1,
    issuer: keyring.issuer,
    keyId,
  };
  const parsed = parseClaims(complete);
  const first = "v1";
  const second = base64url(encoder.encode(keyId));
  const third = base64url(encoder.encode(canonicalJson(parsed)));
  const signingInput = `${first}.${second}.${third}`;
  const signature = hmac(sha256, key.secret, encoder.encode(signingInput));
  return `${signingInput}.${base64url(signature)}`;
}

/** Signs host-private canonical JSON under a domain-separated purpose. */
export function signPrivateAuthorityToken(
  purpose: string,
  claims: unknown,
  keyring: CapabilityKeyring,
): string {
  if (!purpose) {
    throw new CrankError("invalid_manifest", "Private token purpose is required");
  }
  const keyId = keyring.activeKeyId;
  const key = keyringState(keyring).get(keyId);
  if (!key || key.status !== "active") {
    throw invalid();
  }
  const body = canonicalJson(claims);
  const keyPart = base64url(encoder.encode(keyId));
  const claimsPart = base64url(encoder.encode(body));
  const signingInput = `pv1.${base64url(encoder.encode(purpose))}.${keyPart}.${claimsPart}`;
  return `${signingInput}.${base64url(hmac(sha256, key.secret, encoder.encode(signingInput)))}`;
}

/** Verifies and returns host-private canonical JSON for one exact purpose. */
export function verifyPrivateAuthorityToken(
  token: string,
  purpose: string,
  keyring: CapabilityKeyring,
): unknown {
  try {
    const [version, purposePart, keyPart, claimsPart, signaturePart, ...extra] = token.split(".");
    if (
      version !== "pv1" ||
      !purposePart ||
      !keyPart ||
      !claimsPart ||
      !signaturePart ||
      extra.length
    ) {
      throw invalid();
    }
    if (new TextDecoder().decode(fromBase64url(purposePart)) !== purpose) {
      throw invalid();
    }
    const keyId = new TextDecoder().decode(fromBase64url(keyPart));
    const key = keyringState(keyring).get(keyId);
    if (!key || key.status === "retired") {
      throw invalid();
    }
    const signingInput = [version, purposePart, keyPart, claimsPart].join(".");
    if (
      !equalBytes(
        hmac(sha256, key.secret, encoder.encode(signingInput)),
        fromBase64url(signaturePart),
      )
    ) {
      throw invalid();
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(fromBase64url(claimsPart));
    const claims: unknown = JSON.parse(decoded);
    if (canonicalJson(claims) !== decoded) {
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

/** Authenticates and parses an exact canonical capability DTO. */
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
    const key = keyringState(keyring).get(keyId);
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
    const claims = parseClaims(JSON.parse(decoded));
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

/** Verifies program authority and fences mismatched journal, task, epoch, or audience claims. */
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

/** Verifies a pull-resolution capability for the required audience. */
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

/** Narrows authenticated claims to program execution authority. */
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

/** Narrows authenticated claims to pull-resolution authority. */
export function isResolutionClaims(claims: CapabilityClaims): claims is ResolutionCapabilityClaims {
  return (
    Array.isArray(claims.permissions) &&
    claims.permissions.length === 1 &&
    claims.permissions[0] === "resolve"
  );
}

const capabilityCommonSchema = {
  version: z.literal(1),
  issuer: z.string().min(1),
  keyId: z.string().min(1),
  journalId: z.string().min(1),
  journalIncarnation: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  audience: z.string().min(1),
  nonce: z.string().min(1),
} as const;

const programCapabilityClaimsSchema = z.strictObject({
  ...capabilityCommonSchema,
  programId: z.string().min(1),
  programVersion: z.string().min(1),
  programDigest: z.string().min(1),
  attachmentId: z.string().min(1),
  executionEpoch: z.number().int().nonnegative(),
  permissions: z.tuple([z.literal("propose"), z.literal("complete")]),
});

const resolutionCapabilityClaimsSchema = z.strictObject({
  ...capabilityCommonSchema,
  pullId: z.string().min(1),
  descriptorDigest: z.string().min(1),
  resultSchemaDigest: z.string().min(1),
  attemptId: z.string().min(1),
  maxOutcomeBytes: z.number().int().nonnegative(),
  permissions: z.tuple([z.literal("resolve")]),
});

const capabilityClaimsSchema = z.union([
  programCapabilityClaimsSchema,
  resolutionCapabilityClaimsSchema,
]);

export const capabilityClaimsParser = parser(capabilityClaimsSchema).map(
  (value): CapabilityClaims => value as CapabilityClaims,
);

function parseClaims(input: unknown): CapabilityClaims {
  const parsed = capabilityClaimsParser.parse(input);
  if (!parsed.ok) {
    throw invalid();
  }
  return parsed.value;
}

function keyringState(keyring: CapabilityKeyring): KeyringState {
  const state = keyringStates.get(keyring);
  if (!state) {
    throw new CrankError("invalid_manifest", "Capability keyring was not created by this module");
  }
  return state;
}

function invalid(): CrankError {
  return new CrankError("invalid_resolution_capability", "Invalid capability token");
}

/**
 * base64url via `btoa`/`atob` rather than Node's Buffer.
 *
 * Capabilities are minted and verified wherever the authority runs, which
 * includes browsers and edge runtimes. Buffer is a Node global: it breaks
 * browser bundling, and depending on it here would tie the session contract to
 * one runtime for no reason.
 */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw invalid();
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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
