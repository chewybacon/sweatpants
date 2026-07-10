import type { Operation } from "effection";
import type { ZodSchema } from "zod";
import type {
  CreateToolBuilderBase,
  CoreToolCtx,
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
  return createUnifiedToolBuilder({ name, annotations: {}, extensions: [] }) as CreateToolBuilderBase<TName>;
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
      const metadata = extension.metadata ?? (extension.namespace ? { namespace: extension.namespace } : {});
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
    execute(fn: (input: unknown, ctx: CoreToolCtx) => Operation<unknown>) {
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
  impl: (input: unknown, ctx: CoreToolCtx) => Operation<unknown>;
}): ToolDefinition {
  const normalizedElicits = normalizeCoreElicits(options.elicits);
  const normalizedSamples = options.samples === true ? {} : normalizeCoreSamples(options.samples ?? {});
  const factory = function unifiedToolFactory(
    ctx: CoreToolCtx,
  ): Operation<(input: unknown) => Operation<unknown>> {
    return {
      *[Symbol.iterator]() {
        const invoke = (input: unknown): Operation<unknown> =>
          (function* (): Operation<unknown> {
            const parsed = options.parameters.safeParse(input);
            if (!parsed.success || parsed.data === undefined) {
              throw codedToolError(
                "invalid_tool_input",
                `Invalid input for tool "${options.name}": ${parsed.error?.message ?? "validation failed"}`,
              );
            }
            const result = yield* options.impl(parsed.data, ctx);
            if (options.output) {
              const parsedOutput = options.output.safeParse(result);
              if (!parsedOutput.success || parsedOutput.data === undefined) {
                throw codedToolError(
                  "invalid_tool_output",
                  `Invalid output for tool "${options.name}": ${parsedOutput.error?.message ?? "validation failed"}`,
                );
              }
              return parsedOutput.data;
            }
            return result;
          })();
        return invoke;
      },
    };
  };

  Object.defineProperties(factory, {
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
  if (!value || typeof value !== "object") return false;
  if (typeof (value as { safeParse?: unknown }).safeParse === "function") return false;
  return (
    "response" in value ||
    "context" in value ||
    "description" in value ||
    "annotations" in value ||
    "metadata" in value
  );
}
