import serializeCanonical from "canonicalize";
import { sha256 as hashSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** Portable, canonical JSON accepted at persistence and transport boundaries. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Read-only view of admitted JSON for encoders and content identities. */
export type ReadonlyJson =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyJson[]
  | { readonly [key: string]: ReadonlyJson };

/** A JSON value known to be keyed, such as a JSON Schema document. */
export type JsonObject = { [key: string]: Json };

/** Structural validation failure with no durable-domain policy attached. */
export class CanonicalJsonError extends TypeError {
  constructor(
    readonly path: string,
    readonly kind: string,
  ) {
    super(`Value at ${path} is not canonical JSON (${kind})`);
    this.name = "CanonicalJsonError";
  }
}

/** Validate a JSON boundary value and encode deterministic content-identity bytes. */
export function canonicalJson(value: unknown): string {
  return encodeCanonicalJson(assertJson(value));
}

/** Encode admitted JSON without validating or copying it again. */
export function encodeCanonicalJson(value: ReadonlyJson): string {
  return serializeCanonical(value)!;
}

/** Hash admitted JSON when its content needs a stable identity. */
export function digestCanonicalJson(value: ReadonlyJson): string {
  return sha256(encodeCanonicalJson(value));
}

/** Capture a caller's value and the deterministic bytes used for its content identity. */
export function canonicalSnapshot<T>(value: T): { value: T; canonical: string } {
  const captured = assertJson(value);
  return { value: captured as T, canonical: encodeCanonicalJson(captured) };
}

/** Hash deterministic JSON bytes. Ordinary storage envelopes do not need this. */
export function canonicalDigest(value: unknown): string {
  return digestCanonicalJson(assertJson(value));
}

/** Validate and detach a JSON boundary value without encoding it. */
export function cloneJson<T>(value: T): T {
  return assertJson(value) as T;
}

/** Returns lowercase SHA-256 hex for a UTF-8 string. */
export function sha256(value: string): string {
  return sha256Bytes(new TextEncoder().encode(value));
}

/** Returns lowercase SHA-256 hex for exact bytes without text transcoding. */
export function sha256Bytes(value: Uint8Array): string {
  return bytesToHex(hashSha256(value));
}

/** Hashes a canonical tuple without serializing its components with a delimiter. */
export function stableTupleHash(values: readonly unknown[]): string {
  return sha256(canonicalJson(values));
}

export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function replaceControlCharacters(value: string, replacement = " "): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    result += code <= 0x1f || code === 0x7f ? replacement : value[index];
  }
  return result;
}

/** Unicode code-point ordering used by protocol-visible string sets. */
export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const count = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < count; index += 1) {
    const difference = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

/** Non-mutating sort for protocol-visible string sets. */
export function sortStrings(
  values: readonly string[],
  compare: (left: string, right: string) => number = compareUnicodeCodePoints,
): string[] {
  return [...values].sort(compare);
}

/** Decode external JSON text and capture its portable value. */
export function parseJsonText(text: string, path = "$"): Json {
  return assertJson(JSON.parse(text), path);
}

/** Parses unknown input into a fresh canonical keyed JSON object. */
export function parseJsonObject(value: unknown, path = "$"): JsonObject {
  return requireJsonObject(assertJson(value, path), path);
}

/**
 * Narrows already-parsed JSON to its keyed-object variant without traversing,
 * cloning, or revalidating its children.
 */
export function requireJsonObject(value: Json, path = "$"): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(path, "expected a keyed JSON object");
  }
  return value;
}

/**
 * Capture unknown JSON at an ownership boundary. Reject values that JSON would
 * silently discard or transform. Already accepted internal state needs no copy.
 * An optional depth bound starts at this value, independently of any envelope.
 */
export function assertJson(
  value: unknown,
  path = "$",
  options?: { readonly maxDepth: number },
): Json {
  return captureJson(value, path, new Set<object>(), options?.maxDepth);
}

function captureJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  maxDepth: number | undefined,
): Json {
  if (maxDepth !== undefined && ancestors.size > maxDepth) {
    throw invalid(path, "maximum depth exceeded");
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    assertValidUnicode(value, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalid(path, "non-finite number");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw invalid(path, typeof value);
  }
  if (ancestors.has(value)) {
    throw invalid(path, "cycle");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          throw invalid(`${path}[${index}]`, "sparse array slot");
        }
        if (!("value" in descriptor)) {
          throw invalid(`${path}[${index}]`, "accessor property");
        }
        output.push(captureJson(descriptor.value, `${path}[${index}]`, ancestors, maxDepth));
      }
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        throw invalid(path, "non-index array property");
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid(path, "non-plain object");
    }
    const output: Record<string, Json> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw invalid(path, "symbol-keyed property");
      }
      if (key === "__proto__") {
        throw invalid(`${path}.${key}`, "prototype key");
      }
      assertValidUnicode(key, `${path}.<key>`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw invalid(`${path}.${key}`, "non-enumerable or accessor property");
      }
      output[key] = captureJson(descriptor.value, `${path}.${key}`, ancestors, maxDepth);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function assertValidUnicode(value: string, path: string): void {
  // Unicode mode matches lone surrogates, never a valid surrogate pair.
  const surrogate = /[\uD800-\uDFFF]/u.exec(value)?.[0];
  if (surrogate) {
    throw invalid(
      path,
      surrogate.charCodeAt(0) <= 0xdbff ? "lone high surrogate" : "lone low surrogate",
    );
  }
}

function invalid(path: string, kind: string): CanonicalJsonError {
  return new CanonicalJsonError(path, kind);
}
