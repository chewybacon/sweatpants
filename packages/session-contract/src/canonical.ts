import { createHash } from 'node:crypto'

import { CrankError, type Json } from './types.ts'

/** RFC 8785 uses ECMAScript JSON number/string serialization and UTF-16 key order. */
export function canonicalJson(value: Json): string {
  return encode(assertJson(value))
}

export function canonicalSnapshot(value: unknown): { value: Json; canonical: string; sha: string } {
  const canonical = encode(assertJson(value))
  const snapshot = JSON.parse(canonical) as Json
  return { value: snapshot, canonical, sha: sha256(canonical) }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function stableOpaqueId(prefix: string, value: Json): string {
  return `${prefix}_${sha256(canonicalJson(value)).slice(0, 32)}`
}

export function assertJson(value: unknown, path = '$', seen = new Set<object>()): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(path, 'non-finite number')
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') throw invalid(path, typeof value)
  if (seen.has(value)) throw invalid(path, 'cycle')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => assertJson(item, `${path}[${index}]`, seen))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw invalid(path, 'non-plain object')
    const output: Record<string, Json> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      output[key] = assertJson((value as Record<string, unknown>)[key], `${path}.${key}`, seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function encode(value: Json): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encode(value[key]!)}`).join(',')}}`
}

function invalid(path: string, kind: string): CrankError {
  return new CrankError('invalid_pull', `Value at ${path} is not canonical JSON (${kind})`)
}
