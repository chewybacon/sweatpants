import { createApi } from "effection/experimental";
import type { Context, Operation, Subscription } from "effection";
import type { z, ZodSchema } from "zod";
import type {
  ToolConfig,
  ToolImplFn,
  Tool,
  ToolMiddleware,
  ToolFactoryWithImpl,
  ToolFactoryWithoutImpl,
  ContextBinding,
  CreateToolBuilderBase,
  CoreToolCtx,
  UnifiedToolFactory,
  ElicitDefinition,
  ElicitsMap,
  SamplesMap,
  ToolExtensionMetadata,
} from "./types.ts";
import { TransportContext } from "../context/transport.ts";
import type { ElicitResponse } from "../types/transport.ts";

/**
 * Creates a unified tool with the builder chain: createTool(name) →
 * .description() → .parameters() → .elicits() → .execute()/.handoff().
 */
export function createTool<TName extends string>(
  name: TName,
): CreateToolBuilderBase<TName>;

/**
 * Creates a tool with implementation provided in config.
 */
export function createTool<
  TInput extends ZodSchema,
  TProgress extends ZodSchema,
  TOutput extends ZodSchema,
>(
  config: ToolConfig<TInput, TProgress, TOutput> & {
    impl: ToolImplFn<TInput, TProgress, TOutput>;
  },
): ToolFactoryWithImpl<TInput, TOutput>;

/**
 * Creates a tool without implementation.
 * Implementation must be provided at activation, or tool routes to transport.
 */
export function createTool<
  TInput extends ZodSchema,
  TProgress extends ZodSchema | undefined,
  TOutput extends ZodSchema,
>(
  config: ToolConfig<TInput, TProgress, TOutput> & { impl?: never },
): ToolFactoryWithoutImpl<TInput, TProgress, TOutput>;

/**
 * Creates a tool that can be activated and invoked.
 *
 * @example
 * ```ts
 * // Tool with impl in config
 * const Search = createTool({
 *   name: "search",
 *   description: "Search for flights",
 *   input: z.object({ destination: z.string() }),
 *   output: z.object({ flights: z.array(FlightSchema) }),
 *   impl: function* ({ destination }) {
 *     const flights = yield* searchFlights(destination);
 *     return { flights };
 *   },
 * });
 *
 * const search = yield* Search();
 * const result = yield* search({ destination: "Tokyo" });
 *
 * // Tool without impl - provide at activation
 * const GetLocation = createTool({
 *   name: "get-location",
 *   description: "Get user location",
 *   input: z.object({ accuracy: z.enum(["high", "low"]) }),
 *   output: z.object({ lat: z.number(), lng: z.number() }),
 * });
 *
 * const getLocation = yield* GetLocation(implFn);
 * // or route to transport:
 * const getLocation = yield* GetLocation();
 * ```
 */
export function createTool<
  TInput extends ZodSchema,
  TProgress extends ZodSchema | undefined,
  TOutput extends ZodSchema,
>(
  configOrName: ToolConfig<TInput, TProgress, TOutput> | string,
):
  | CreateToolBuilderBase<string>
  | ToolFactoryWithImpl<TInput, TOutput>
  | ToolFactoryWithoutImpl<TInput, TProgress, TOutput> {
  if (typeof configOrName === "string") {
    return createUnifiedToolBuilder({ name: configOrName, annotations: {}, extensions: [] }) as CreateToolBuilderBase<string>;
  }

  const config = configOrName;
  type Input = z.infer<TInput>;
  type Output = z.infer<TOutput>;

  // Create the API for this tool
  // The handler is the default impl or a placeholder that routes to transport
  const api = createApi(config.name, {
    *invoke(_args: Input): Operation<Output> {
      // This will be overridden when tool is activated
      throw new Error(
        `Tool "${config.name}" was invoked but not activated. ` +
        `Call yield* ${config.name}() or yield* ${config.name}(impl) first.`
      );
    },
  });

  // Factory function that activates the tool
  function factory(
    impl?: ToolImplFn<TInput, TProgress, TOutput>,
  ): Operation<Tool<TInput, TOutput>> {
    return {
      *[Symbol.iterator]() {
        // Determine which impl to use
        const actualImpl = impl ?? config.impl;

        if (actualImpl) {
          // Install the config-style impl as middleware that replaces the default.
          // This input-only surface does not provide the unified ToolCtx; tools
          // that need elicit/sample/notify/log/history should use the builder
          // chain createTool(name)...execute((input, ctx) => ...).
          yield* api.around({
            *invoke([args]: [Input], _next: (...args: [Input]) => Operation<Output>) {
              return yield* actualImpl(args);
            },
          });
        } else {
          // No impl - route to transport
          yield* api.around({
            *invoke([args]: [Input], _next: (...args: [Input]) => Operation<Output>) {
              // Get transport from context
              const transport = yield* TransportContext.get();
              if (!transport) {
                throw new Error(
                  `Tool "${config.name}" requires a transport for remote invocation. ` +
                  `Set TransportContext (${TransportContext.name}) before invoking tools without a local implementation.`
                );
              }
              
              // Generate unique request ID
              const requestId = `${config.name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
              
              // Send request through transport and get response stream
              const stream = transport.request<z.infer<TProgress>, ElicitResponse>({
                id: requestId,
                kind: "elicit",
                type: config.name,
                payload: args,
              });
              
              // Subscribe to the stream
              const subscription: Subscription<z.infer<TProgress>, ElicitResponse> = yield* stream;
              
              // Consume the stream until we get the final response
              // Progress updates are currently ignored (TODO: expose via callback or context)
              let result = yield* subscription.next();
              while (!result.done) {
                // Progress update - currently ignored
                // In the future, we could emit these via a progress context
                result = yield* subscription.next();
              }
              
              // result.value is the final response (ElicitResponse)
              const response = result.value;
              
              if (response.status === "accepted") {
                return response.content as Output;
              } else if (response.status === "declined") {
                throw new Error(`Tool "${config.name}" request was declined`);
              } else if (response.status === "cancelled") {
                throw new Error(`Tool "${config.name}" request was cancelled`);
              } else if (response.status === "denied") {
                throw new Error(`Tool "${config.name}" request was denied`);
              } else if (response.status === "other") {
                throw new Error(`Tool "${config.name}" request failed: ${response.content}`);
              }
              
              // TypeScript exhaustiveness check
              throw new Error(`Tool "${config.name}" received unexpected response status`);
            },
          });
        }

        // Return the activated tool function
        const tool: Tool<TInput, TOutput> = (args: Input): Operation<Output> => {
          return api.operations.invoke(args);
        };

        return tool;
      },
    };
  }

  // Attach decorate method
  factory.decorate = function (
    middleware: ToolMiddleware<TInput, TOutput>,
  ): Operation<void> {
    return api.around({
      *invoke([args]: [Input], next: (...args: [Input]) => Operation<Output>) {
        return yield* middleware(args, (...a) => next(...a));
      },
    });
  };

  // Attach withContext method
  factory.withContext = function <T>(
    context: Context<T>,
    value: T,
  ): typeof factory {
    // Create a new factory that wraps this one with context binding
    return createToolWithBindings(config, api, [
      { context: context as Context<unknown>, value },
    ]) as typeof factory;
  };

  // Attach metadata
  Object.defineProperty(factory, "name", {
    value: config.name,
    writable: false,
  });
  Object.defineProperty(factory, "description", {
    value: config.description,
    writable: false,
  });
  Object.defineProperty(factory, "schemas", {
    value: {
      input: config.input,
      output: config.output,
      progress: config.progress,
    },
    writable: false,
  });

  return factory as ToolFactoryWithImpl<TInput, TOutput> | ToolFactoryWithoutImpl<TInput, TProgress, TOutput>;
}


function withContextBindings<T>(
  bindings: ContextBinding[],
  operation: () => Operation<T>,
): Operation<T> {
  return {
    *[Symbol.iterator]() {
      let run = operation;
      for (const binding of bindings) {
        const next = run;
        run = () => binding.context.with(binding.value, function* () {
          return yield* next();
        });
      }
      return yield* run();
    },
  };
}

/**
 * Internal: Create a tool factory with pre-configured context bindings.
 * Used by withContext() to build up the chain of bindings.
 */
function createToolWithBindings<
  TInput extends ZodSchema,
  TProgress extends ZodSchema | undefined,
  TOutput extends ZodSchema,
>(
  config: ToolConfig<TInput, TProgress, TOutput>,
  api: ReturnType<typeof createApi<{ invoke: (args: z.infer<TInput>) => Operation<z.infer<TOutput>> }>>,
  bindings: ContextBinding[],
): ToolFactoryWithImpl<TInput, TOutput> | ToolFactoryWithoutImpl<TInput, TProgress, TOutput> {
  type Input = z.infer<TInput>;
  type Output = z.infer<TOutput>;

  // Factory function that activates the tool with context bindings
  function factory(
    impl?: ToolImplFn<TInput, TProgress, TOutput>,
  ): Operation<Tool<TInput, TOutput>> {
    return {
      *[Symbol.iterator]() {
        // Determine which impl to use
        const actualImpl = impl ?? config.impl;

        if (actualImpl) {
          // Install the config-style impl as middleware that replaces the default.
          // This input-only surface does not provide the unified ToolCtx; tools
          // that need elicit/sample/notify/log/history should use the builder
          // chain createTool(name)...execute((input, ctx) => ...).
          yield* api.around({
            *invoke([args]: [Input], _next: (...args: [Input]) => Operation<Output>) {
              return yield* actualImpl(args);
            },
          });
        } else {
          // No impl - route to transport
          yield* api.around({
            *invoke([args]: [Input], _next: (...args: [Input]) => Operation<Output>) {
              // Get transport from context
              const transport = yield* TransportContext.get();
              if (!transport) {
                throw new Error(
                  `Tool "${config.name}" requires a transport for remote invocation. ` +
                  `Set TransportContext (${TransportContext.name}) before invoking tools without a local implementation.`
                );
              }
              
              // Generate unique request ID
              const requestId = `${config.name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
              
              // Send request through transport and get response stream
              const stream = transport.request<z.infer<TProgress>, ElicitResponse>({
                id: requestId,
                kind: "elicit",
                type: config.name,
                payload: args,
              });
              
              // Subscribe to the stream
              const subscription: Subscription<z.infer<TProgress>, ElicitResponse> = yield* stream;
              
              // Consume the stream until we get the final response
              let result = yield* subscription.next();
              while (!result.done) {
                result = yield* subscription.next();
              }
              
              // result.value is the final response (ElicitResponse)
              const response = result.value;
              
              if (response.status === "accepted") {
                return response.content as Output;
              } else if (response.status === "declined") {
                throw new Error(`Tool "${config.name}" request was declined`);
              } else if (response.status === "cancelled") {
                throw new Error(`Tool "${config.name}" request was cancelled`);
              } else if (response.status === "denied") {
                throw new Error(`Tool "${config.name}" request was denied`);
              } else if (response.status === "other") {
                throw new Error(`Tool "${config.name}" request failed: ${response.content}`);
              }
              
              throw new Error(`Tool "${config.name}" received unexpected response status`);
            },
          });
        }


        // Return the activated tool function with this factory's context
        // bindings applied per invocation. Bindings are kept out of the shared
        // Effection API middleware stack so multiple bound variants of the same
        // tool can coexist in one scope.
        const tool: Tool<TInput, TOutput> = (args: Input): Operation<Output> => {
          return withContextBindings(bindings, () => api.operations.invoke(args));
        };

        return tool;
      },
    };
  }

  // Attach decorate method
  factory.decorate = function (
    middleware: ToolMiddleware<TInput, TOutput>,
  ): Operation<void> {
    return api.around({
      *invoke([args]: [Input], next: (...args: [Input]) => Operation<Output>) {
        return yield* middleware(args, (...a) => next(...a));
      },
    });
  };

  // Attach withContext method - prepends to existing bindings
  factory.withContext = function <T>(
    context: Context<T>,
    value: T,
  ): typeof factory {
    return createToolWithBindings(config, api, [
      { context: context as Context<unknown>, value },
      ...bindings,
    ]) as typeof factory;
  };

  // Attach metadata
  Object.defineProperty(factory, "name", {
    value: config.name,
    writable: false,
  });
  Object.defineProperty(factory, "description", {
    value: config.description,
    writable: false,
  });
  Object.defineProperty(factory, "schemas", {
    value: {
      input: config.input,
      output: config.output,
      progress: config.progress,
    },
    writable: false,
  });

  return factory as ToolFactoryWithImpl<TInput, TOutput> | ToolFactoryWithoutImpl<TInput, TProgress, TOutput>;
}

// =============================================================================
// Unified createTool(name) builder implementation
// =============================================================================

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
      return createUnifiedToolBuilder({ ...state, elicits: normalizeCoreElicits(elicits) as ElicitsMap });
    },
    samples(samples?: SamplesMap) {
      assertHasParameters(state, ".samples()");
      return createUnifiedToolBuilder({ ...state, samples: samples ? normalizeCoreSamples(samples) : true });
    },
    use(extension: { namespace?: string; metadata?: ToolExtensionMetadata; apply?: (state: UnifiedBuilderState) => UnifiedBuilderState | void }) {
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
}): UnifiedToolFactory {
  const normalizedElicits = normalizeCoreElicits(options.elicits);
  const normalizedSamples = options.samples === true ? {} : normalizeCoreSamples(options.samples ?? {});
  const factory = function unifiedToolFactory(ctx: CoreToolCtx): Operation<(input: unknown) => Operation<unknown>> {
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
    description: { value: options.description, enumerable: true, writable: false, configurable: true },
    parameters: { value: options.parameters, enumerable: true, writable: false, configurable: true },
    output: { value: options.output, enumerable: true, writable: false, configurable: true },
    elicits: { value: normalizedElicits, enumerable: true, writable: false, configurable: true },
    samples: { value: normalizedSamples, enumerable: true, writable: false, configurable: true },
    schemas: { value: { input: options.parameters, output: options.output }, enumerable: true, writable: false, configurable: true },
    capabilities: {
      value: {
        elicitation: Object.keys(normalizedElicits).length > 0,
        sampling: options.samples !== undefined,
      },
      enumerable: true,
      writable: false,
      configurable: true,
    },
    annotations: { value: Object.freeze({ ...options.annotations }), enumerable: true, writable: false, configurable: true },
    extensions: { value: Object.freeze([...options.extensions]), enumerable: true, writable: false, configurable: true },
  });

  return factory as unknown as UnifiedToolFactory;
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
