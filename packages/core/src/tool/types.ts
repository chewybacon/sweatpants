import type { Operation } from "effection";
import type { ZodSchema, infer as ZodInfer } from "zod";

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
  args: ZodInfer<TInput>,
  send: TProgress extends ZodSchema
    ? (progress: ZodInfer<TProgress>) => Operation<void>
    : never,
) => Operation<ZodInfer<TOutput>>;

/**
 * An activated tool that can be invoked with input.
 */
export type Tool<TInput extends ZodSchema, TOutput extends ZodSchema> = (
  args: ZodInfer<TInput>,
) => Operation<ZodInfer<TOutput>>;

/**
 * Middleware function for decorating tool invocations.
 */
export type ToolMiddleware<
  TInput extends ZodSchema,
  TOutput extends ZodSchema,
> = (
  args: ZodInfer<TInput>,
  next: (...args: [ZodInfer<TInput>]) => Operation<ZodInfer<TOutput>>,
) => Operation<ZodInfer<TOutput>>;

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
  /** Tool metadata */
  readonly name: string;
  readonly description: string;
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
  /** Tool metadata */
  readonly name: string;
  readonly description: string;
}
