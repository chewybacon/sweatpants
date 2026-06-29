import type { Context, Operation } from "effection";
import type { z, ZodSchema } from "zod";

/**
 * A binding of a context to a value, used for Tool.withContext().
 */
export interface ContextBinding<T = unknown> {
  context: Context<T>;
  value: T;
}

/**
 * Configuration for creating a legacy/config-style tool.
 */
export interface ToolConfig<
  TInput extends ZodSchema,
  TProgress extends ZodSchema | undefined,
  TOutput extends ZodSchema,
> {
  /** Unique name for the tool */
  name: string;
  /** Description for LLM tool calling */
  description: string;
  /** Zod schema for input validation */
  input: TInput;
  /** Zod schema for output validation */
  output: TOutput;
  /** Optional Zod schema for progress updates */
  progress?: TProgress;
  /** Optional implementation - if not provided, routes to transport */
  impl?: ToolImplFn<TInput, TProgress, TOutput>;
}

/**
 * Config-style tool implementation function.
 */
export type ToolImplFn<
  TInput extends ZodSchema,
  _TProgress extends ZodSchema | undefined,
  TOutput extends ZodSchema,
> = (args: z.infer<TInput>) => Operation<z.infer<TOutput>>;

/**
 * An activated legacy/config-style tool that can be invoked with input.
 */
export type Tool<TInput extends ZodSchema, TOutput extends ZodSchema> = (
  args: z.infer<TInput>,
) => Operation<z.infer<TOutput>>;

/**
 * Middleware function for decorating legacy/config-style tool invocations.
 */
export type ToolMiddleware<
  TInput extends ZodSchema,
  TOutput extends ZodSchema,
> = (
  args: z.infer<TInput>,
  next: (...args: [z.infer<TInput>]) => Operation<z.infer<TOutput>>,
) => Operation<z.infer<TOutput>>;

/**
 * Tool factory returned when impl is provided in config.
 */
export interface ToolFactoryWithImpl<
  TInput extends ZodSchema,
  TOutput extends ZodSchema,
> {
  (): Operation<Tool<TInput, TOutput>>;
  decorate(middleware: ToolMiddleware<TInput, TOutput>): Operation<void>;
  withContext<T>(context: Context<T>, value: T): ToolFactoryWithImpl<TInput, TOutput>;
  readonly name: string;
  readonly description: string;
  readonly schemas: {
    readonly input: TInput;
    readonly output: TOutput;
  };
}

/**
 * Tool factory returned when impl is NOT provided in config.
 */
export interface ToolFactoryWithoutImpl<
  TInput extends ZodSchema,
  TProgress extends ZodSchema | undefined,
  TOutput extends ZodSchema,
> {
  (impl?: ToolImplFn<TInput, TProgress, TOutput>): Operation<Tool<TInput, TOutput>>;
  decorate(middleware: ToolMiddleware<TInput, TOutput>): Operation<void>;
  withContext<T>(context: Context<T>, value: T): ToolFactoryWithoutImpl<TInput, TProgress, TOutput>;
  readonly name: string;
  readonly description: string;
  readonly schemas: {
    readonly input: TInput;
    readonly output: TOutput;
    readonly progress: TProgress;
  };
}

// =============================================================================
// Canonical core tool substrate
// =============================================================================

export type LogLevel = "debug" | "info" | "warning" | "error";
export type InferSchema<T> = T extends ZodSchema<infer O> ? O : T extends { _output: infer O } ? O : unknown;
export type AnySchema<T = unknown> = ZodSchema<T>;

export interface PerCallInterruptOptions {
  reason?: string;
  expiresAt?: string;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ElicitDefinition<TContextSchema = undefined, TResponseSchema = ZodSchema> {
  readonly description?: string;
  readonly context?: TContextSchema;
  readonly response: TResponseSchema;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ElicitEntry<TResponseSchema = ZodSchema, TContextSchema = undefined> =
  | TResponseSchema
  | ElicitDefinition<TContextSchema, TResponseSchema>;

export type ElicitsMap = Record<string, ElicitEntry<any, any>>;

export type ExtractElicitResponse<E> = E extends ElicitDefinition<any, infer TResponseSchema>
  ? InferSchema<TResponseSchema>
  : InferSchema<E>;

export type ExtractElicitContext<E> = E extends ElicitDefinition<infer TContextSchema, any>
  ? TContextSchema extends undefined
    ? undefined
    : InferSchema<TContextSchema>
  : undefined;

export type ExtractElicitResponseSchema<E> = E extends ElicitDefinition<any, infer TResponseSchema>
  ? TResponseSchema
  : E;

export type ExtractElicitContextSchema<E> = E extends ElicitDefinition<infer TContextSchema, any>
  ? TContextSchema
  : undefined;

export type NormalizedElicitDefinition<TContext = unknown, TResponse = unknown> = ElicitDefinition<ZodSchema<TContext> | undefined, ZodSchema<TResponse>>;
export type NormalizedElicitsMap<TElicits extends ElicitsMap = ElicitsMap> = {
  readonly [K in keyof TElicits]: NormalizedElicitDefinition<ExtractElicitContext<TElicits[K]>, ExtractElicitResponse<TElicits[K]>>;
};

export interface SampleDefinition<TOutputSchema = undefined> {
  readonly description?: string;
  readonly output?: TOutputSchema;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type SamplesMap = Record<string, SampleDefinition<any>>;
export type NormalizedSamplesMap<TSamples extends SamplesMap = SamplesMap> = {
  readonly [K in keyof TSamples]: SampleDefinition<TSamples[K] extends SampleDefinition<infer O> ? O : undefined>;
};

export interface ElicitExchange<TContext = unknown, TResponse = unknown> {
  readonly kind: "elicit";
  readonly key: string;
  readonly request: {
    readonly message: string;
    readonly context?: TContext;
  };
  readonly response:
    | { readonly action: "accept"; readonly content: TResponse }
    | { readonly action: "decline"; readonly reason?: string }
    | { readonly action: "cancel"; readonly reason?: string };
}

export interface SampleExchange<TRequest = unknown, TResponse = unknown> {
  readonly kind: "sample";
  readonly key?: string;
  readonly request: TRequest;
  readonly response: TResponse;
}

export type InteractionExchange = ElicitExchange<unknown, unknown> | SampleExchange<unknown, unknown>;

export type CoreElicitResult<TContext, TResponse> =
  | { action: "accept"; content: TResponse; exchange: ElicitExchange<TContext, TResponse> }
  | { action: "decline"; reason?: string; exchange: ElicitExchange<TContext, undefined> }
  | { action: "cancel"; reason?: string; exchange: ElicitExchange<TContext, undefined> };

export interface SampleRequest {
  readonly prompt?: string;
  readonly messages?: readonly unknown[];
  readonly exchanges?: readonly InteractionExchange[];
  readonly options?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface SampleResult<TParsed = unknown> {
  readonly content?: string;
  readonly text?: string;
  readonly parsed?: TParsed;
  readonly exchange: SampleExchange<SampleRequest, unknown>;
  readonly raw?: unknown;
}

export interface BaseToolCtx {
  [key: string]: unknown;
  readonly history: unknown[];
  notify(message: string, fraction?: number, level?: LogLevel): Operation<void>;
  log(level: LogLevel, message: string): Operation<void>;
}

type ElicitRequestFor<E> = ExtractElicitContext<E> extends undefined
  ? { message: string; interrupt?: PerCallInterruptOptions }
  : { message: string; context: ExtractElicitContext<E>; interrupt?: PerCallInterruptOptions };

export interface ToolElicitCtx<TElicits extends ElicitsMap> {
  elicit<K extends keyof TElicits & string>(
    key: K,
    request: ElicitRequestFor<TElicits[K]>,
  ): Operation<CoreElicitResult<ExtractElicitContext<TElicits[K]>, ExtractElicitResponse<TElicits[K]>>>;
}

export interface ToolGenericSampleCtx {
  sample(request: SampleRequest): Operation<SampleResult>;
}

type SampleParsed<TSamples extends SamplesMap, K extends keyof TSamples> = TSamples[K] extends SampleDefinition<infer TOutputSchema>
  ? TOutputSchema extends undefined
    ? unknown
    : InferSchema<TOutputSchema>
  : unknown;

export interface ToolNamedSampleCtx<TSamples extends SamplesMap> {
  sample(request: SampleRequest): Operation<SampleResult>;
  sample<K extends keyof TSamples & string>(key: K, request: SampleRequest): Operation<SampleResult<SampleParsed<TSamples, K>>>;
}

type ElicitCtxIfDeclared<TElicits> = TElicits extends ElicitsMap
  ? keyof TElicits extends never
    ? {}
    : ToolElicitCtx<TElicits>
  : {};

type SampleCtxIfDeclared<TSamples> = TSamples extends true
  ? ToolGenericSampleCtx
  : TSamples extends SamplesMap
    ? ToolNamedSampleCtx<TSamples>
    : {};

export type ToolCtx<TElicits = undefined, TSamples = undefined> = BaseToolCtx & ElicitCtxIfDeclared<TElicits> & SampleCtxIfDeclared<TSamples>;
export type CoreToolCtx<TElicits = undefined, TSamples = undefined> = ToolCtx<TElicits, TSamples>;

export interface ToolExtensionMetadata {
  readonly namespace?: string;
  readonly value?: unknown;
  readonly [key: string]: unknown;
}

export interface ToolExtension<TState = unknown, TMetadata extends ToolExtensionMetadata = ToolExtensionMetadata> {
  readonly namespace?: string;
  readonly metadata?: TMetadata;
  apply?(state: TState): TState | void;
}

export interface ToolDefinition<
  TName extends string = string,
  TParams = unknown,
  TResult = unknown,
  TElicits extends ElicitsMap = {},
  TSamples extends SamplesMap | true | undefined = undefined,
> {
  (ctx: ToolCtx<TElicits, TSamples>): Operation<(input: TParams) => Operation<TResult>>;
  readonly name: TName;
  readonly description: string;
  readonly parameters: ZodSchema<TParams>;
  readonly output?: ZodSchema<TResult>;
  readonly elicits: NormalizedElicitsMap<TElicits>;
  readonly samples: TSamples extends SamplesMap ? NormalizedSamplesMap<TSamples> : Readonly<Record<string, never>>;
  readonly schemas: { readonly input: ZodSchema<TParams>; readonly output?: ZodSchema<TResult> };
  readonly capabilities: { readonly elicitation: boolean; readonly sampling: boolean };
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly extensions: readonly ToolExtensionMetadata[];
}

export type UnifiedToolFactory<
  I = unknown,
  O = unknown,
  TElicits extends ElicitsMap = {},
  TSamples extends SamplesMap | true | undefined = undefined,
> = ToolDefinition<string, I, O, TElicits, TSamples>;

export type UnifiedTool<
  I = unknown,
  O = unknown,
  TElicits extends ElicitsMap = {},
  TSamples extends SamplesMap | true | undefined = undefined,
> = UnifiedToolFactory<I, O, TElicits, TSamples>;

export interface CreateToolBuilderBase<TName extends string> {
  description(desc: string): CreateToolBuilderWithDescription<TName>;
}

export interface CreateToolBuilderWithDescription<TName extends string> {
  parameters<TSchema extends ZodSchema>(schema: TSchema): CreateToolBuilderWithParams<TName, z.infer<TSchema>, undefined, undefined, undefined>;
}

export interface CreateToolBuilderWithParams<
  TName extends string,
  TInput,
  TOutput = undefined,
  TElicits extends ElicitsMap | undefined = undefined,
  TSamples extends SamplesMap | true | undefined = undefined,
> {
  output<TSchema extends ZodSchema>(schema: TSchema): CreateToolBuilderWithParams<TName, TInput, z.infer<TSchema>, TElicits, TSamples>;
  elicits<TNextElicits extends ElicitsMap>(elicits: TNextElicits): CreateToolBuilderWithParams<TName, TInput, TOutput, TNextElicits, TSamples>;
  samples(): CreateToolBuilderWithParams<TName, TInput, TOutput, TElicits, true>;
  samples<TNextSamples extends SamplesMap>(samples: TNextSamples): CreateToolBuilderWithParams<TName, TInput, TOutput, TElicits, TNextSamples>;
  use(extension: ToolExtension<CreateToolBuilderWithParams<TName, TInput, TOutput, TElicits, TSamples>>): CreateToolBuilderWithParams<TName, TInput, TOutput, TElicits, TSamples>;
  annotate(namespace: string, value: unknown): CreateToolBuilderWithParams<TName, TInput, TOutput, TElicits, TSamples>;
  /** Compatibility no-op during first-party migration; canonical capability metadata is derived from declarations. */
  requires(caps: { elicitation?: boolean; sampling?: boolean }): CreateToolBuilderWithParams<TName, TInput, TOutput, TElicits, TSamples>;
  execute<TResult extends (TOutput extends undefined ? unknown : TOutput)>(
    fn: (input: TInput, ctx: ToolCtx<TElicits, TSamples>) => Operation<TResult>,
  ): ToolDefinition<
    TName,
    TInput,
    TOutput extends undefined ? TResult : TOutput,
    TElicits extends ElicitsMap ? TElicits : {},
    TSamples
  >;
}

/** Compatibility alias for older type names. */
export type CreateToolBuilderWithElicits<
  TName extends string,
  TInput,
  TElicits extends ElicitsMap,
> = CreateToolBuilderWithParams<TName, TInput, undefined, TElicits, undefined>;
