import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation } from "effection";
import {
  safeSchemaIssues,
  validateAuthoredSchema,
  type ParseIssue,
} from "@sweatpants/foundation/parser";

import { buildToolSchemaArtifacts } from "./artifacts.ts";
import { computeToolInterfaceDigest } from "./contract.ts";
import { compileToolInteractionBindings } from "./interaction-binding.ts";
import { isStandardSchema } from "../schema/zod-adapter.ts";
import type {
  CreateToolBuilderBase,
  ToolCtx,
  ElicitDefinition,
  ElicitsMap,
  SamplesMap,
  ToolDefinition,
  ToolExtensionMetadata,
  SchemaProjectionOptions,
} from "./types.ts";

/**
 * Creates a canonical tool builder:
 * createTool(name) → .description() → .parameters() → .elicits()/.samples() → .execute().
 */
export function createTool<TName extends string>(name: TName): CreateToolBuilderBase<TName> {
  return createUnifiedToolBuilder({
    name,
    annotations: {},
    extensions: [],
  }) as CreateToolBuilderBase<TName>;
}

interface UnifiedBuilderState {
  name: string;
  description?: string;
  parameters?: StandardSchemaV1;
  parametersProjections?: SchemaProjectionOptions;
  output?: StandardSchemaV1;
  outputProjections?: SchemaProjectionOptions;
  elicits?: ElicitsMap;
  samples?: SamplesMap | true;
  annotations: Record<string, unknown>;
  extensions: ToolExtensionMetadata[];
}

function createUnifiedToolBuilder(state: UnifiedBuilderState): unknown {
  return {
    description(desc: string) {
      return createUnifiedToolBuilder({ ...state, description: desc });
    },
    parameters(schema: StandardSchemaV1, projections?: SchemaProjectionOptions) {
      if (!isStandardSchema(schema)) {
        throw new Error(`Tool "${state.name}": parameters must implement Standard Schema V1`);
      }
      if (!state.description) {
        throw new Error(`Tool "${state.name}": .description() must be called before .parameters()`);
      }
      return createUnifiedToolBuilder({
        ...state,
        parameters: schema,
        ...(projections ? { parametersProjections: projections } : {}),
      });
    },
    output(schema: StandardSchemaV1, projections?: SchemaProjectionOptions) {
      if (!isStandardSchema(schema)) {
        throw new Error(`Tool "${state.name}": output must implement Standard Schema V1`);
      }
      assertHasParameters(state, ".output()");
      return createUnifiedToolBuilder({
        ...state,
        output: schema,
        ...(projections ? { outputProjections: projections } : {}),
      });
    },
    elicits(elicits: ElicitsMap) {
      assertHasParameters(state, ".elicits()");
      return createUnifiedToolBuilder({
        ...state,
        elicits: normalizeCoreElicits(elicits) as ElicitsMap,
      });
    },
    samples(samples?: SamplesMap) {
      assertHasParameters(state, ".samples()");
      return createUnifiedToolBuilder({
        ...state,
        samples: samples ? normalizeCoreSamples(samples) : true,
      });
    },
    use(extension: {
      namespace?: string;
      metadata?: ToolExtensionMetadata;
      apply?: (state: UnifiedBuilderState) => UnifiedBuilderState | void;
    }) {
      assertHasParameters(state, ".use()");
      const metadata =
        extension.metadata ?? (extension.namespace ? { namespace: extension.namespace } : {});
      const next: UnifiedBuilderState = { ...state, extensions: [...state.extensions, metadata] };
      const applied = extension.apply?.(next);
      return createUnifiedToolBuilder(applied ?? next);
    },
    requires(_caps: { elicitation?: boolean; sampling?: boolean }) {
      assertHasParameters(state, ".requires()");
      return createUnifiedToolBuilder(state);
    },
    annotate(namespace: string, value: unknown) {
      assertHasParameters(state, ".annotate()");
      return createUnifiedToolBuilder({
        ...state,
        annotations: { ...state.annotations, [namespace]: value },
      });
    },
    execute(fn: (input: unknown, ctx: ToolCtx) => Operation<unknown>) {
      assertUnifiedReady(state, ".execute()");
      return finalizeCoreUnifiedTool({
        name: state.name,
        description: state.description!,
        parameters: state.parameters!,
        ...(state.parametersProjections
          ? { parametersProjections: state.parametersProjections }
          : {}),
        ...(state.output ? { output: state.output } : {}),
        ...(state.outputProjections ? { outputProjections: state.outputProjections } : {}),
        elicits: state.elicits ?? {},
        samples: state.samples,
        annotations: state.annotations,
        extensions: state.extensions,
        impl: fn,
      });
    },
  };
}

function assertHasParameters(state: UnifiedBuilderState, stage: string): void {
  if (!state.description) {
    throw new Error(`Tool "${state.name}": .description() must be called before ${stage}`);
  }
  if (!state.parameters) {
    throw new Error(`Tool "${state.name}": .parameters() must be called before ${stage}`);
  }
}

function assertUnifiedReady(state: UnifiedBuilderState, terminal: string): void {
  assertHasParameters(state, terminal);
}

function finalizeCoreUnifiedTool(options: {
  name: string;
  description: string;
  parameters: StandardSchemaV1;
  parametersProjections?: SchemaProjectionOptions;
  output?: StandardSchemaV1 | undefined;
  outputProjections?: SchemaProjectionOptions;
  elicits: ElicitsMap;
  samples?: SamplesMap | true | undefined;
  annotations: Record<string, unknown>;
  extensions: ToolExtensionMetadata[];
  impl: (input: unknown, ctx: ToolCtx) => Operation<unknown>;
}): ToolDefinition {
  const normalizedElicits = normalizeCoreElicits(options.elicits);
  const normalizedSamples =
    options.samples === true ? {} : normalizeCoreSamples(options.samples ?? {});
  const artifacts = buildToolSchemaArtifacts({
    identity: `tool:${options.name}`,
    version: schemaVersionAnnotation(options.annotations),
    parameters: options.parameters,
    ...(options.parametersProjections
      ? { parametersProjections: options.parametersProjections }
      : {}),
    output: options.output,
    ...(options.outputProjections ? { outputProjections: options.outputProjections } : {}),
    elicits: normalizedElicits as Record<
      string,
      ElicitDefinition<StandardSchemaV1, StandardSchemaV1 | undefined>
    >,
  });
  const interfaceDigest = computeToolInterfaceDigest({
    name: options.name,
    parameters: artifacts.parameters,
    ...(artifacts.output ? { output: artifacts.output } : {}),
    elicits: artifacts.elicits,
    annotations: options.annotations,
    extensions: options.extensions,
  });
  const bindings = compileToolInteractionBindings({
    ownerInterfaceDigest: interfaceDigest,
    elicits: normalizedElicits,
    artifacts: artifacts.elicits,
  });
  const factory = function unifiedToolFactory(
    ctx: ToolCtx,
  ): Operation<(input: unknown) => Operation<unknown>> {
    return {
      *[Symbol.iterator]() {
        const invoke = (input: unknown): Operation<unknown> =>
          (function* (): Operation<unknown> {
            const parsed = validateAuthoredSchema(options.parameters, input);
            if (parsed.status === "schema-error") {
              throw codedToolError("invalid_tool_input", "Tool input schema implementation failed");
            }
            if (parsed.status === "invalid") {
              throw codedToolError(
                "invalid_tool_input",
                `Invalid input for tool "${options.name}": ${describeIssues(parsed.issues)}`,
              );
            }
            const result = yield* options.impl(parsed.value, ctx);
            if (options.output) {
              const parsedOutput = validateAuthoredSchema(options.output, result);
              if (parsedOutput.status === "schema-error") {
                throw codedToolError(
                  "invalid_tool_output",
                  "Tool output schema implementation failed",
                );
              }
              if (parsedOutput.status === "invalid") {
                throw codedToolError(
                  "invalid_tool_output",
                  `Invalid output for tool "${options.name}": ${describeIssues(parsedOutput.issues)}`,
                );
              }
              return parsedOutput.value;
            }
            return result;
          })();
        return invoke;
      },
    };
  };

  Object.defineProperties(factory, {
    execution: { value: "ordinary", enumerable: true, writable: false, configurable: true },
    name: { value: options.name, enumerable: true, writable: false, configurable: true },
    description: {
      value: options.description,
      enumerable: true,
      writable: false,
      configurable: true,
    },
    parameters: {
      value: options.parameters,
      enumerable: true,
      writable: false,
      configurable: true,
    },
    output: { value: options.output, enumerable: true, writable: false, configurable: true },
    elicits: {
      value: normalizedElicits,
      enumerable: true,
      writable: false,
      configurable: true,
    },
    samples: {
      value: normalizedSamples,
      enumerable: true,
      writable: false,
      configurable: true,
    },
    schemas: {
      value: { input: options.parameters, output: options.output },
      enumerable: true,
      writable: false,
      configurable: true,
    },
    artifacts: { value: artifacts, enumerable: true, writable: false, configurable: true },
    capabilities: {
      value: {
        elicitation: Object.keys(normalizedElicits).length > 0,
        sampling: options.samples !== undefined,
      },
      enumerable: true,
      writable: false,
      configurable: true,
    },
    annotations: {
      value: Object.freeze({ ...options.annotations }),
      enumerable: true,
      writable: false,
      configurable: true,
    },
    extensions: {
      value: Object.freeze([...options.extensions]),
      enumerable: true,
      writable: false,
      configurable: true,
    },
    interfaceDigest: {
      value: interfaceDigest,
      enumerable: true,
      writable: false,
      configurable: true,
    },
    bindings: {
      value: bindings,
      enumerable: true,
      writable: false,
      configurable: true,
    },
  });

  return factory as unknown as ToolDefinition;
}

function describeIssues(issues: readonly ParseIssue[]): string {
  if (issues.length === 0) {
    return "validation failed";
  }
  return safeSchemaIssues(issues)
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
}

function schemaVersionAnnotation(annotations: Record<string, unknown>): string {
  const declared = annotations["sweatpants/schemaVersion"];
  return typeof declared === "string" && declared ? declared : "1";
}

function codedToolError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function normalizeCoreElicits(elicits: ElicitsMap): Record<string, ElicitDefinition> {
  const normalized: Record<string, ElicitDefinition> = {};
  for (const [key, entry] of Object.entries(elicits)) {
    const def: ElicitDefinition = isElicitDefinitionLike(entry)
      ? { ...(entry as ElicitDefinition) }
      : { response: entry };
    if (def.response === undefined) {
      throw new Error(`Tool elicit "${key}" is missing a response schema`);
    }
    normalized[key] = def;
  }
  return normalized;
}

function normalizeCoreSamples(samples: SamplesMap): SamplesMap {
  const normalized: SamplesMap = {};
  for (const [key, entry] of Object.entries(samples)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Tool sample "${key}" must be an object definition`);
    }
    normalized[key] = { ...entry };
  }
  return normalized;
}

function isElicitDefinitionLike(value: unknown): value is ElicitDefinition {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (typeof (value as { safeParse?: unknown }).safeParse === "function") {
    return false;
  }
  return (
    "response" in value ||
    "context" in value ||
    "description" in value ||
    "annotations" in value ||
    "metadata" in value
  );
}
