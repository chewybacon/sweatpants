import type { ElicitRequest } from "./mcp-tool-types.ts";

/** Canonical schema extension carrying private elicitation render context. */
export const MODEL_CONTEXT_SCHEMA_KEY = "x-elicit-context";

/** Reads context only from the canonical schema extension. */
export function getElicitContext<T extends Record<string, unknown> = Record<string, unknown>>(
  req: ElicitRequest,
): T {
  const value = req.schema.json[MODEL_CONTEXT_SCHEMA_KEY];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : ({} as T);
}
