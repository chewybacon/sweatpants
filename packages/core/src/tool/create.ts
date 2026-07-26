import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation } from "effection";
import type { ZodSchema } from "zod";
import { safeSchemaIssues, validateStandardSchema } from "@sweatpants/session-contract";

import { buildToolSchemaArtifacts } from "./artifacts.ts";
import type {
  CreateToolBuilderBase,
  ToolCtx,
  ElicitDefinition,
  ElicitsMap,
  SamplesMap,
  ToolDefinition,
  ToolExtensionMetadata,
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
  parameters?: ZodSchema;
  output?: ZodSchema;
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
    parameters(schema: ZodSchema) {
      if (!state.description) {
        throw new Error(`Tool "${state.name}": .description() must be called before .parameters()`);
      }
      return createUnifiedToolBuilder({ ...state, parameters: schema });
    },
    output(schema: ZodSchema) {
      assertHasParameters(state, ".output()");
      return createUnifiedToolBuilder({ ...state, output: schema });
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
        output: state.output,
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
  parameters: ZodSchema;
  output?: ZodSchema | undefined;
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
    parameters: options.parameters as StandardSchemaV1,
    output: options.output as StandardSchemaV1 | undefined,
    elicits: normalizedElicits as Record<
      string,
      ElicitDefinition<StandardSchemaV1, StandardSchemaV1 | undefined>
    >,
  });
  const factory = function unifiedToolFactory(
    ctx: ToolCtx,
  ): Operation<(input: unknown) => Operation<unknown>> {
    return {
      *[Symbol.iterator]() {
        const invoke = (input: unknown): Operation<unknown> =>
          (function* (): Operation<unknown> {
            // Validation flows through the Standard Schema interface; sync or
            // Promise-returning validators compose as Effection operations.
            const parsed = yield* validateStandardSchema(
              options.parameters as StandardSchemaV1,
              input,
            );
            if (parsed.issues !== undefined || parsed.value === undefined) {
              throw codedToolError(
                "invalid_tool_input",
                `Invalid input for tool "${options.name}": ${describeIssues(
                  parsed.issues ?? undefined,
                )}`,
              );
            }
            const result = yield* options.impl(parsed.value, ctx);
            if (options.output) {
              const parsedOutput = yield* validateStandardSchema(
                options.output as StandardSchemaV1,
                result,
              );
              if (parsedOutput.issues !== undefined || parsedOutput.value === undefined) {
                throw codedToolError(
                  "invalid_tool_output",
                  `Invalid output for tool "${options.name}": ${describeIssues(
                    parsedOutput.issues ?? undefined,
                  )}`,
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
  });

  return factory as unknown as ToolDefinition;
}

function describeIssues(issues: readonly StandardSchemaV1.Issue[] | undefined): string {
  if (!issues || issues.length === 0) {
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
