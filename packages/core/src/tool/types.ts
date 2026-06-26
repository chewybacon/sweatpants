import type { Context, Operation } from "effection";
import type { z, ZodSchema } from "zod";
import type {
  ElicitDefinition,
  ElicitsMap,
  ExtractElicitContext,
  ExtractElicitResponse,
} from "../types/unified-tool.ts";

/**
 * A binding of a context to a value, used for Tool.withContext().
 */
export interface ContextBinding<T = unknown> {
  context: Context<T>;
  value: T;
}

/**
 * Configuration for creating a tool.
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
 * Tool implementation function.
 * Takes input args and a send function for progress updates.
 */
export type ToolImplFn<
  TInput extends ZodSchema,
  TProgress extends ZodSchema | undefined,
  TOutput extends ZodSchema,
> = (
  args: z.infer<TInput>,
  send: TProgress extends ZodSchema
    ? (progress: z.infer<TProgress>) => Operation<void>
    : never,
) => Operation<z.infer<TOutput>>;

/**
 * An activated tool that can be invoked with input.
 */
export type Tool<TInput extends ZodSchema, TOutput extends ZodSchema> = (
  args: z.infer<TInput>,
) => Operation<z.infer<TOutput>>;

/**
 * Middleware function for decorating tool invocations.
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
 * Call with no args to activate.
 */
export interface ToolFactoryWithImpl<
  TInput extends ZodSchema,
  TOutput extends ZodSchema,
> {
  /** Activate the tool using impl from config */
  (): Operation<Tool<TInput, TOutput>>;
  /** Register middleware for this tool */
  decorate(
    middleware: ToolMiddleware<TInput, TOutput>,
  ): Operation<void>;
  /** 
   * Return a new tool factory with context binding.
   * When the tool is invoked, it will run within the given context.
   * Multiple withContext calls chain - first is outermost, last is innermost.
   */
  withContext<T>(context: Context<T>, value: T): ToolFactoryWithImpl<TInput, TOutput>;
  /** Tool metadata */
  readonly name: string;
  readonly description: string;
  /** Tool schemas for input/output validation */
  readonly schemas: {
    readonly input: TInput;
    readonly output: TOutput;
  };
}

/**
 * Tool factory returned when impl is NOT provided in config.
 * Call with optional impl to activate.
 */
export interface ToolFactoryWithoutImpl<
  TInput extends ZodSchema,
  TProgress extends ZodSchema | undefined,
  TOutput extends ZodSchema,
> {
  /** Activate with provided impl, or route to transport if not provided */
  (impl?: ToolImplFn<TInput, TProgress, TOutput>): Operation<
    Tool<TInput, TOutput>
  >;
  /** Register middleware for this tool */
  decorate(
    middleware: ToolMiddleware<TInput, TOutput>,
  ): Operation<void>;
  /** 
   * Return a new tool factory with context binding.
   * When the tool is invoked, it will run within the given context.
   * Multiple withContext calls chain - first is outermost, last is innermost.
   */
  withContext<T>(context: Context<T>, value: T): ToolFactoryWithoutImpl<TInput, TProgress, TOutput>;
  /** Tool metadata */
  readonly name: string;
  readonly description: string;
  /** Tool schemas for input/output/progress validation */
  readonly schemas: {
    readonly input: TInput;
    readonly output: TOutput;
    readonly progress: TProgress;
  };
}

// =============================================================================
// Unified tool builder types (migration path for createTool(name) chain)
// =============================================================================

export interface PerCallInterruptOptions {
  reason?: string;
  expiresAt?: string;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
}

export type CoreElicitResult<TContext, TResponse> =
  | { action: "accept"; content: TResponse; exchange: { context?: TContext } | unknown; status: "accepted"; value: TResponse }
  | { action: "decline"; status: "declined"; reason?: string }
  | { action: "cancel"; status: "cancelled"; reason?: string };

export interface CoreToolCtx<TElicits extends ElicitsMap = {}> {
  history: unknown[];
  elicit<K extends keyof TElicits & string>(
    key: K,
    options: { message: string } & ExtractElicitContext<TElicits[K]> & { interrupt?: PerCallInterruptOptions },
  ): Operation<CoreElicitResult<ExtractElicitContext<TElicits[K]>, ExtractElicitResponse<TElicits[K]>>>;
  elicitDynamic(options: {
    key: string;
    message: string;
    responseSchema?: unknown;
    contextSchema?: unknown;
    context?: unknown;
    reason?: string;
    expiresAt?: string;
    ttlMs?: number;
    mode?: "form" | "url";
    metadata?: Record<string, unknown>;
  }): Operation<CoreElicitResult<unknown, unknown>>;
  sample<TParsed = undefined>(options: Record<string, unknown>): Operation<{ content: string; parsed?: TParsed; exchange?: unknown }>;
  notify(message: string, fraction?: number, level?: "debug" | "info" | "warning" | "error"): Operation<void>;
  log(level: "debug" | "info" | "warning" | "error", message: string): Operation<void>;
}

export interface UnifiedToolFactory<
  I = unknown,
  O = unknown,
  TElicits extends ElicitsMap = ElicitsMap,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters: ZodSchema<I>;
  readonly elicits: Record<string, ElicitDefinition>;
  readonly schemas: { input: ZodSchema<I>; output?: unknown };
  readonly capabilities: { elicitation?: boolean; sampling?: boolean };
  (ctx: CoreToolCtx<TElicits>): Operation<(input: I) => Operation<O>>;
}

export interface CreateToolBuilderBase<TName extends string> {
  description(desc: string): CreateToolBuilderWithDescription<TName>;
}

export interface CreateToolBuilderWithDescription<TName extends string> {
  parameters<TSchema extends ZodSchema>(schema: TSchema): CreateToolBuilderWithParams<TName, z.infer<TSchema>>;
}

export interface CreateToolBuilderWithParams<TName extends string, TInput> {
  elicits<TElicits extends ElicitsMap>(elicits: TElicits): CreateToolBuilderWithElicits<TName, TInput, TElicits>;
}

export interface CreateToolBuilderWithElicits<
  TName extends string,
  TInput,
  TElicits extends ElicitsMap,
> {
  requires(caps: { elicitation?: boolean; sampling?: boolean }): CreateToolBuilderWithElicits<TName, TInput, TElicits>;
  execute<TResult>(
    fn: (input: TInput, ctx: CoreToolCtx<TElicits>) => Operation<TResult>,
  ): UnifiedToolFactory<TInput, TResult, TElicits>;
  handoff<THandoff, TClient, TResult>(config: {
    before?: (input: TInput, ctx: { callId: string; signal: AbortSignal }) => Operation<THandoff>;
    client: (handoff: THandoff, ctx: CoreToolCtx<TElicits>, input: TInput) => Operation<TClient>;
    after: (
      handoff: THandoff,
      client: TClient,
      ctx: { callId: string; signal: AbortSignal },
      input: TInput,
    ) => Operation<TResult>;
  }): UnifiedToolFactory<TInput, TResult, TElicits>;
}
