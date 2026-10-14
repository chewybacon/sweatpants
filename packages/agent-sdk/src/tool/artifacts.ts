import { documentElicitContextSchema } from "./documents.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { SchemaBinding } from "@sweatpants/foundation/schema";

import { toPortableSchema } from "../schema/zod-adapter.ts";
import type { ToolElicitSchemaArtifact, ToolSchemaArtifacts } from "./contract.ts";
import type { ElicitDefinition, SchemaProjectionOptions } from "./types.ts";

/** Inputs for lowering one tool's runtime schemas into portable artifacts. */
export interface ToolSchemaArtifactInputs {
  /** Semantic identity prefix, e.g. `tool:pick_card` or `yo-chat.pick-card`. */
  readonly identity: string;
  /** Semantic schema version shared by the tool's schema domain. */
  readonly version: string;
  readonly parameters: StandardSchemaV1;
  readonly parametersProjections?: SchemaProjectionOptions;
  readonly output?: StandardSchemaV1 | undefined;
  readonly outputProjections?: SchemaProjectionOptions;
  readonly elicits: Readonly<
    Record<string, ElicitDefinition<StandardSchemaV1, StandardSchemaV1 | undefined>>
  >;
}

/** Lowers all authored schemas of one tool into descriptors plus a validator catalog. */
export function buildToolSchemaArtifacts(inputs: ToolSchemaArtifactInputs): ToolSchemaArtifacts {
  const catalog: SchemaBinding[] = [];
  const parameters = toPortableSchema(inputs.parameters, {
    identity: `${inputs.identity}/parameters`,
    role: "tool_parameters",
    version: inputs.version,
    ...(inputs.parametersProjections ?? {}),
  });
  catalog.push(parameters.entry);

  let output;
  if (inputs.output) {
    output = toPortableSchema(inputs.output, {
      identity: `${inputs.identity}/output`,
      role: "tool_output",
      version: inputs.version,
      ...(inputs.outputProjections ?? {}),
    });
    catalog.push(output.entry);
  }

  const elicits: Record<string, ToolElicitSchemaArtifact> = {};
  for (const [key, definition] of Object.entries(inputs.elicits)) {
    const response = toPortableSchema(definition.response, {
      identity: `${inputs.identity}/elicits/${key}/response`,
      role: "elicit_response",
      version: inputs.version,
      ...(definition.responseProjections ?? {}),
    });
    catalog.push(response.entry);
    let context;
    const contextSchema =
      definition.documents && Object.keys(definition.documents).length > 0
        ? documentElicitContextSchema(definition.context, definition.documents)
        : definition.context;
    if (contextSchema) {
      context = toPortableSchema(contextSchema, {
        identity: `${inputs.identity}/elicits/${key}/context`,
        role: "elicit_context",
        version: inputs.version,
        ...(definition.contextProjections ?? {}),
      });
      catalog.push(context.entry);
    }
    const documents: Record<string, SchemaBinding["descriptor"]> = {};
    for (const [slot, schema] of Object.entries(definition.documents ?? {})) {
      const artifact = toPortableSchema(schema, {
        identity: `${inputs.identity}/elicits/${key}/documents/${slot}`,
        role: "elicit_context",
        version: inputs.version,
      });
      documents[slot] = artifact.descriptor;
      catalog.push(artifact.entry);
    }
    elicits[key] = {
      response: response.descriptor,
      ...(Object.keys(documents).length ? { documents } : {}),
      ...(context ? { context: context.descriptor } : {}),
    };
  }

  return Object.freeze({
    parameters: parameters.descriptor,
    ...(output ? { output: output.descriptor } : {}),
    elicits: Object.freeze(elicits),
    catalog: Object.freeze(catalog),
  });
}
