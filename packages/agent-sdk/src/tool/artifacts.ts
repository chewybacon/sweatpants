import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { SchemaBinding } from "@sweatpants/foundation/schema-descriptor";

import { toPortableSchema } from "../schema/zod-adapter.ts";
import type { ToolElicitSchemaArtifact, ToolSchemaArtifacts } from "./contract.ts";
import type { ElicitDefinition } from "./types.ts";

/** Inputs for lowering one tool's runtime schemas into portable artifacts. */
export interface ToolSchemaArtifactInputs {
  /** Semantic identity prefix, e.g. `tool:pick_card` or `yo-chat.pick-card`. */
  readonly identity: string;
  /** Semantic schema version shared by the tool's schema domain. */
  readonly version: string;
  readonly parameters: StandardSchemaV1;
  readonly output?: StandardSchemaV1 | undefined;
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
  });
  catalog.push(parameters.entry);

  let output;
  if (inputs.output) {
    output = toPortableSchema(inputs.output, {
      identity: `${inputs.identity}/output`,
      role: "tool_output",
      version: inputs.version,
    });
    catalog.push(output.entry);
  }

  const elicits: Record<string, ToolElicitSchemaArtifact> = {};
  for (const [key, definition] of Object.entries(inputs.elicits)) {
    const response = toPortableSchema(definition.response, {
      identity: `${inputs.identity}/elicits/${key}/response`,
      role: "elicit_response",
      version: inputs.version,
    });
    catalog.push(response.entry);
    let context;
    if (definition.context) {
      context = toPortableSchema(definition.context, {
        identity: `${inputs.identity}/elicits/${key}/context`,
        role: "elicit_context",
        version: inputs.version,
      });
      catalog.push(context.entry);
    }
    elicits[key] = {
      response: response.descriptor,
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
