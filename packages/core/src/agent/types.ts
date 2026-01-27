import type { Operation } from "effection";
import type { ZodSchema, infer as ZodInfer, input as ZodInput } from "zod";
import type {
  Tool,
  ToolMiddleware,
  ToolFactoryWithImpl,
  ToolFactoryWithoutImpl,
} from "../tool/types.ts";

// ============================================================================
// Tool Factory Types
// ============================================================================

/**
 * Union of all tool factory types.
 */
export type AnyToolFactory =
  | ToolFactoryWithImpl<ZodSchema, ZodSchema>
  | ToolFactoryWithoutImpl<ZodSchema, ZodSchema | undefined, ZodSchema>;

/**
 * Extract the Tool type from a tool factory.
 */
export type ToolFromFactory<T extends AnyToolFactory> =
  T extends ToolFactoryWithImpl<infer TInput, infer TOutput>
    ? Tool<TInput, TOutput>
    : T extends ToolFactoryWithoutImpl<infer TInput, ZodSchema | undefined, infer TOutput>
      ? Tool<TInput, TOutput>
      : never;

/**
 * Extract the input schema type from a tool factory.
 */
export type InputFromFactory<T extends AnyToolFactory> =
  T extends ToolFactoryWithImpl<infer TInput, ZodSchema>
    ? TInput
    : T extends ToolFactoryWithoutImpl<infer TInput, ZodSchema | undefined, ZodSchema>
      ? TInput
      : never;

/**
 * Extract the output schema type from a tool factory.
 */
export type OutputFromFactory<T extends AnyToolFactory> =
  T extends ToolFactoryWithImpl<ZodSchema, infer TOutput>
    ? TOutput
    : T extends ToolFactoryWithoutImpl<ZodSchema, ZodSchema | undefined, infer TOutput>
      ? TOutput
      : never;

// ============================================================================
// Agent Configuration
// ============================================================================

/**
 * Configuration for creating an agent.
 */
export interface AgentConfig<
  TConfig extends ZodSchema | undefined,
  TTools extends Record<string, AnyToolFactory>,
> {
  /** Unique name for the agent */
  name: string;
  /** Description of what the agent does */
  description: string;
  /** Optional Zod schema for agent configuration */
  config?: TConfig;
  /** Tools available on this agent */
  tools: TTools;
}

// ============================================================================
// Agent Instance (Activated)
// ============================================================================

/**
 * An activated agent instance with callable tools.
 */
export type Agent<TTools extends Record<string, AnyToolFactory>> = {
  [K in keyof TTools]: ToolFromFactory<TTools[K]>;
};

// ============================================================================
// Agent Middleware
// ============================================================================

/**
 * Middleware configuration for an agent's tools.
 * Each key corresponds to a tool name, value is the middleware for that tool.
 */
export type AgentMiddleware<TTools extends Record<string, AnyToolFactory>> = {
  [K in keyof TTools]?: ToolMiddleware<
    InputFromFactory<TTools[K]>,
    OutputFromFactory<TTools[K]>
  >;
};

// ============================================================================
// Agent Factory (What createAgent returns)
// ============================================================================

/**
 * Base properties shared by all agent factories.
 */
interface AgentFactoryBase<TTools extends Record<string, AnyToolFactory>> {
  /** The tool factories belonging to this agent */
  readonly tools: TTools;
  /** Agent name */
  readonly name: string;
  /** Agent description */
  readonly description: string;
  /** Register middleware for agent's tools */
  decorate(middleware: Partial<AgentMiddleware<TTools>>): Operation<void>;
}

/**
 * Agent factory when config schema is provided.
 * Requires config argument when activating.
 */
export interface AgentFactoryWithConfig<
  TConfig extends ZodSchema,
  TTools extends Record<string, AnyToolFactory>,
> extends AgentFactoryBase<TTools> {
  /** Activate the agent with configuration (uses z.input to allow defaults) */
  (config: ZodInput<TConfig>): Operation<Agent<TTools>>;
  /** Access agent config from within a tool (must be in agent's scope) */
  useConfig(): Operation<ZodInfer<TConfig>>;
}

/**
 * Agent factory when no config schema is provided.
 * No arguments required when activating.
 */
export interface AgentFactoryWithoutConfig<
  TTools extends Record<string, AnyToolFactory>,
> extends AgentFactoryBase<TTools> {
  /** Activate the agent */
  (): Operation<Agent<TTools>>;
}

/**
 * Union type for agent factory based on whether config is defined.
 */
export type AgentFactory<
  TConfig extends ZodSchema | undefined,
  TTools extends Record<string, AnyToolFactory>,
> = TConfig extends ZodSchema
  ? AgentFactoryWithConfig<TConfig, TTools>
  : AgentFactoryWithoutConfig<TTools>;
