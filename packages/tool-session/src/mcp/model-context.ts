import { z } from "zod";
import type { ElicitRequest } from "./mcp-tool-types.ts";

/** Canonical schema extension carrying private elicitation render context. */
export const MODEL_CONTEXT_SCHEMA_KEY = "x-elicit-context";

/** Reads context only from the canonical schema extension. */
export function getElicitContext<T extends Record<string, unknown> = Record<string, unknown>>(
  req: ElicitRequest,
): T {
  const parsed = z.record(z.string(), z.json()).safeParse(req.schema.json[MODEL_CONTEXT_SCHEMA_KEY]);
  return (parsed.success ? parsed.data : {}) as T;
}
