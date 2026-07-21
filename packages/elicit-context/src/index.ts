/**
 * @sweatpants/elicit-context
 *
 * x-elicit-context wire encoding for MCP elicitation.
 * Canonical elicit ontology lives in @sweatpants/core.
 *
 * @packageDocumentation
 */

export { encodeElicitContext } from './encode.ts'
export { decodeElicitContext } from './decode.ts'
export type {
  JsonSchema,
  EncodedElicitContext,
  DecodedElicitContext,
} from './types.ts'
