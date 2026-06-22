import { z } from 'zod'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isZodSchema(value: unknown): value is z.ZodType {
  return isRecord(value)
    && (typeof (value as { safeParse?: unknown }).safeParse === 'function'
      || (typeof (value as { parse?: unknown }).parse === 'function' && '_def' in value))
}

function stripNonJson(value: unknown): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (Array.isArray(value)) {
    return value
      .map(stripNonJson)
      .filter((entry) => entry !== undefined)
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      const normalized = stripNonJson(entry)
      if (normalized !== undefined) {
        result[key] = normalized
      }
    }
    return result
  }

  return value
}

/**
 * Convert provider-facing schemas to clone-safe JSON Schema.
 *
 * Tool definitions can be rich internally (for example, Zod schemas). The pi-ai
 * provider boundary must send only data schemas because Bedrock/pi-ai may clone
 * and validate provider payloads before dispatch.
 */
export function toProviderJsonSchema(schema: unknown): Record<string, unknown> {
  if (isZodSchema(schema)) {
    const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema)
    return stripNonJson(jsonSchema) as Record<string, unknown>
  }

  if (isRecord(schema)) {
    return stripNonJson(schema) as Record<string, unknown>
  }

  return { type: 'object', properties: {}, required: [] }
}
