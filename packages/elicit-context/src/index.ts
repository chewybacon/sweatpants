/**
 * @sweatpants/elicit-context
 * 
 * x-elicit-context specification and utilities for MCP elicitation.
 * 
 * This package defines how structured context data is transported alongside
 * MCP elicit requests, enabling rich UI rendering in MCP clients.
 * 
 * @packageDocumentation
 */

export { encodeElicitContext } from './encode'
export { decodeElicitContext, stripMessageContext } from './decode'
export type {
  ElicitDefinition,
  ElicitsMap,
  ElicitRequest,
  ElicitOptions,
  JsonSchema,
  EncodedElicitContext,
  DecodedElicitContext,
  ExtractElicitResponse,
  ExtractElicitContext,
  ExtractElicitResponseSchema,
  ExtractElicitContextSchema,
} from './types'
