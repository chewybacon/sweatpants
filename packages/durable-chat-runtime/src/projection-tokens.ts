import { fromByteArray, toByteArray } from "base64-js";
import { canonicalJson, parseJsonText, type Json } from "@sweatpants/foundation";
import {
  MAX_PROJECTION_TOKEN_BYTES,
  decodePublicHistoryCursorPayload,
  decodePublicProjectionBasis,
  type PublicHistoryCursorPayload,
  type PublicProjectionBasis,
} from "@sweatpants/chat-core";

export interface ProjectionTokenKeyring {
  readonly activeKey: Uint8Array;
  readonly verificationKeys?: readonly Uint8Array[];
}

/** Construct a bounded HMAC keyring from deployment-owned secrets. */
export function createProjectionTokenKeyring(
  activeSecret: string,
  verificationSecrets: readonly string[] = [],
): ProjectionTokenKeyring {
  const key = (secret: string, path: string): Uint8Array => {
    const bytes = encoder.encode(secret);
    if (bytes.byteLength < 32 || bytes.byteLength > 4_096) {
      throw new ProjectionTokenError(
        "public_history_cursor_invalid",
        `${path} must contain 32 to 4096 UTF-8 bytes`,
      );
    }
    return bytes;
  };
  return {
    activeKey: key(activeSecret, "active projection-token secret"),
    verificationKeys:
      verificationSecrets.length === 0
        ? undefined
        : verificationSecrets.map((secret, index) =>
            key(secret, `projection-token verification secret ${index}`),
          ),
  };
}

export class ProjectionTokenError extends Error {
  constructor(
    readonly code: "public_history_cursor_invalid" | "public_history_cursor_expired",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectionTokenError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function base64url(bytes: Uint8Array): string {
  return fromByteArray(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new ProjectionTokenError(
      "public_history_cursor_invalid",
      "Projection token contains invalid base64url",
    );
  }
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    return toByteArray(padded);
  } catch (error) {
    throw new ProjectionTokenError(
      "public_history_cursor_invalid",
      "Projection token base64url is invalid",
      { cause: error },
    );
  }
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

async function hmac(keyBytes: Uint8Array, payload: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, arrayBuffer(payload)));
}

async function verifyHmac(
  keyBytes: Uint8Array,
  payload: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify("HMAC", key, arrayBuffer(signature), arrayBuffer(payload));
}

async function signPayload(payload: Json, keyring: ProjectionTokenKeyring): Promise<string> {
  const bytes = encoder.encode(canonicalJson(payload));
  if (bytes.byteLength > MAX_PROJECTION_TOKEN_BYTES) {
    throw new ProjectionTokenError(
      "public_history_cursor_invalid",
      "Projection token payload exceeds 64 KiB",
    );
  }
  const signature = await hmac(keyring.activeKey, bytes);
  return `${base64url(bytes)}.${base64url(signature)}`;
}

async function verifiedPayload(token: string, keyring: ProjectionTokenKeyring): Promise<unknown> {
  if (encoder.encode(token).byteLength > MAX_PROJECTION_TOKEN_BYTES * 2) {
    throw new ProjectionTokenError(
      "public_history_cursor_invalid",
      "Projection token exceeds its transfer bound",
    );
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new ProjectionTokenError(
      "public_history_cursor_invalid",
      "Projection token must contain payload and MAC",
    );
  }
  const payload = fromBase64url(parts[0]!);
  const signature = fromBase64url(parts[1]!);
  if (payload.byteLength > MAX_PROJECTION_TOKEN_BYTES || signature.byteLength !== 32) {
    throw new ProjectionTokenError(
      "public_history_cursor_invalid",
      "Projection token payload or MAC has an invalid size",
    );
  }
  const keys = [keyring.activeKey, ...(keyring.verificationKeys ?? [])];
  let accepted = false;
  for (const key of keys) {
    if (await verifyHmac(key, payload, signature)) {
      accepted = true;
      break;
    }
  }
  if (!accepted) {
    throw new ProjectionTokenError(
      "public_history_cursor_invalid",
      "Projection token MAC is invalid",
    );
  }
  try {
    return parseJsonText(decoder.decode(payload), "projection token payload");
  } catch (error) {
    throw new ProjectionTokenError(
      "public_history_cursor_invalid",
      "Projection token payload is invalid JSON",
      { cause: error },
    );
  }
}

function assertLive(expiresAt: number, now: number): void {
  if (now >= expiresAt) {
    throw new ProjectionTokenError("public_history_cursor_expired", "Projection token has expired");
  }
}

export async function mintWindowToken(
  basis: PublicProjectionBasis,
  keyring: ProjectionTokenKeyring,
): Promise<string> {
  const value = decodePublicProjectionBasis(basis);
  return await signPayload(value as unknown as Json, keyring);
}

export async function verifyWindowToken(
  token: string,
  keyring: ProjectionTokenKeyring,
  now = Date.now(),
): Promise<PublicProjectionBasis> {
  const payload = await verifiedPayload(token, keyring);
  let basis: PublicProjectionBasis;
  try {
    basis = decodePublicProjectionBasis(payload);
  } catch (error) {
    throw new ProjectionTokenError(
      "public_history_cursor_invalid",
      "Projection window basis is invalid",
      { cause: error },
    );
  }
  assertLive(basis.expiresAt, now);
  return basis;
}

export async function mintPublicHistoryCursor(
  payload: PublicHistoryCursorPayload,
  keyring: ProjectionTokenKeyring,
): Promise<string> {
  const value = decodePublicHistoryCursorPayload(payload);
  return await signPayload(value as unknown as Json, keyring);
}

/**
 * History cursors retain the signed projection basis, including its window-token
 * timestamps, but do not expire with that window. The history endpoint checks
 * current authorization and archive lineage/frontier on every read.
 */
export async function verifyPublicHistoryCursor(
  token: string,
  keyring: ProjectionTokenKeyring,
): Promise<PublicHistoryCursorPayload> {
  const payload = await verifiedPayload(token, keyring);
  let cursor: PublicHistoryCursorPayload;
  try {
    cursor = decodePublicHistoryCursorPayload(payload);
  } catch (error) {
    throw new ProjectionTokenError(
      "public_history_cursor_invalid",
      "Public history cursor basis is invalid",
      { cause: error },
    );
  }
  return cursor;
}
