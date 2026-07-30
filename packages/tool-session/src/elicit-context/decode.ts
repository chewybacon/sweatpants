import { z } from "zod";
import type { JsonSchema, DecodedElicitContext } from "./types.ts";

/** Decodes context only from the canonical `x-elicit-context` schema extension. */
export function decodeElicitContext<TContext = Record<string, unknown>>(
  message: string,
  schema: JsonSchema,
): DecodedElicitContext<TContext> {
  const value = schema["x-elicit-context"];
  const context = z.record(z.string(), z.json()).safeParse(value);
  return {
    message,
    // TContext is the caller-authored context contract; the extension only
    // proves the portable JSON-object envelope before handing it to that port.
    context: (context.success ? context.data : {}) as TContext,
  };
}
