import { sha256 as hashSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { CrankError, type Json } from "./types.ts";

/** RFC 8785 uses ECMAScript JSON number serialization and UTF-16 key order. */
export function canonicalJson(value: unknown): string {
  return encode(assertJson(value));
}

/**
 * Validate, canonicalize, and JSON-clone a value while preserving its static
 * type. Validation rejects every value whose runtime shape would not survive
 * the clone, so callers do not need repetitive descriptor/outcome casts.
 */
export function canonicalSnapshot<T>(value: T): { value: T; canonical: string; sha: string } {
  const canonical = encode(assertJson(value));
  const snapshot: unknown = JSON.parse(canonical);
  // SAFETY: assertJson rejects every value that cannot survive this canonical
  // JSON round trip; parsing therefore preserves T's JSON-representable shape.
  return { value: snapshot as T, canonical, sha: sha256(canonical) };
}

/** Returns lowercase SHA-256 hex for a UTF-8 string. */
export function sha256(value: string): string {
  return sha256Bytes(new TextEncoder().encode(value));
}

/** Returns lowercase SHA-256 hex for exact bytes without text transcoding. */
export function sha256Bytes(value: Uint8Array): string {
  return bytesToHex(hashSha256(value));
}

/** Derives a stable, payload-hiding identifier from canonical JSON. */
export function stableOpaqueId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256(canonicalJson(value)).slice(0, 32)}`;
}

/**
 * Parses unknown input into a fresh canonical-JSON projection, rejecting cycles,
 * accessors, sparse arrays, invalid Unicode, prototypes, and non-finite numbers.
 */
export function assertJson(value: unknown, path = "$", seen = new Set<object>()): Json {
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
  if (seen.has(value)) {
    throw invalid(path, "cycle");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output: Json[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw invalid(`${path}[${index}]`, "sparse array slot");
        }
        output.push(assertJson(value[index], `${path}[${index}]`, seen));
      }
      const extraKeys = Reflect.ownKeys(value).filter(
        (key) =>
          key !== "length" &&
          !(typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length),
      );
      if (extraKeys.length > 0) {
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
      assertValidUnicode(key, `${path}.<key>`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw invalid(`${path}.${key}`, "non-enumerable or accessor property");
      }
      output[key] = assertJson(descriptor.value, `${path}.${key}`, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function encode(value: Json): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(encode).join(",")}]`;
  }
  return `{${sortedEntries(value)
    .map(([key, child]) => `${JSON.stringify(key)}:${encode(child)}`)
    .join(",")}}`;
}

function sortedEntries(value: Record<string, Json>): Array<[string, Json]> {
  const result: Array<[string, Json]> = [];
  for (const entry of Object.entries(value)) {
    let index = 0;
    while (index < result.length && (result[index]?.[0] ?? "") < entry[0]) {
      index += 1;
    }
    result.splice(index, 0, entry);
  }
  return result;
}

function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw invalid(path, "lone high surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw invalid(path, "lone low surrogate");
    }
  }
}

function invalid(path: string, kind: string): CrankError {
  return new CrankError("invalid_pull", `Value at ${path} is not canonical JSON (${kind})`);
}
