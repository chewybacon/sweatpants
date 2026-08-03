/**
 * x-elicit-context wire data types.
 * Ontology types (ElicitDefinition, ElicitsMap, extractors) live in @sweatpants/agent-sdk.
 */

export type JsonSchema = Record<string, unknown>;

export interface EncodedElicitContext {
  message: string;
  schema: JsonSchema;
}
