/**
 * Unified tool type helpers — re-exported from the canonical core tool ontology.
 * Kept as a thin re-export so historical import paths continue to resolve to the
 * single definition in `tool/types.ts`.
 */

export type {
  ElicitDefinition,
  ElicitEntry,
  ElicitsMap,
  ExtractElicitResponse,
  ExtractElicitContext,
  ExtractElicitResponseSchema,
  ExtractElicitContextSchema,
} from "../tool/types.ts";
