/**
 * x-elicit-context wire data types.
 * Ontology types (ElicitDefinition, ElicitsMap, extractors) live in @sweatpants/core.
 */

export type JsonSchema = Record<string, unknown>;

export interface EncodedElicitContext {
  message: string;
  schema: JsonSchema;
}

export interface DecodedElicitContext<TContext = Record<string, unknown>> {
  message: string;
  context: TContext;
}
