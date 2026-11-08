import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Json } from "@sweatpants/foundation";
import type { Effects } from "./journal-compiler.ts";
import type {
  ElicitsMap,
  ToolExtensionMetadata,
  ToolSchemaArtifacts,
  SamplesMap,
} from "./types.ts";
import type { ToolInteractionBindings } from "./interaction-binding.ts";

/** One compiled authoring product. Native scheduling is an adapter detail. */
export abstract class ToolDefinition<
  P extends StandardSchemaV1 = StandardSchemaV1,
  Result = Json,
  L extends ElicitsMap = ElicitsMap,
  E extends Effects = Effects,
  N extends string = string,
> {
  declare readonly name: N;
  declare readonly description: string;
  declare readonly parameters: P;
  declare readonly output?: StandardSchemaV1<unknown, Result>;
  declare readonly version?: string;
  declare readonly elicits: L;
  declare readonly effects: E;
  declare readonly samples: SamplesMap;
  declare readonly artifacts: ToolSchemaArtifacts;
  declare readonly capabilities: { readonly elicitation: boolean; readonly sampling: boolean };
  declare readonly annotations: Readonly<Record<string, unknown>>;
  declare readonly extensions: readonly ToolExtensionMetadata[];
  declare readonly interfaceDigest: string;
  declare readonly bindings: ToolInteractionBindings;
  // Compile-time evidence survives even when no output schema is supplied.
  // Protected keeps the type in emitted declarations (private would erase it).
  // It is not an executable member or a runtime property.
  declare protected readonly result: Result;
}
