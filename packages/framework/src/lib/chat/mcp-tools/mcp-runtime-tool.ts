/**
 * Compatibility re-exports for residual importers.
 * Prefer @sweatpants/core ToolDefinition / AnyToolDefinition.
 */
export type {
  ToolDefinition,
  AnyToolDefinition,
} from "@sweatpants/core";

/** @deprecated Use ToolDefinition from @sweatpants/core */
export type McpRuntimeTool<
  TName extends string = string,
  TParams = unknown,
  _TInteraction = unknown,
  _TClient = unknown,
  TResult = unknown,
  _TElicits = {},
  _TSamples = undefined,
> = import("@sweatpants/core").ToolDefinition<TName, TParams, TResult, any, any>;

/** @deprecated Use AnyToolDefinition */
export type AnyMcpTool = import("@sweatpants/core").AnyToolDefinition;
/** @deprecated Use AnyToolDefinition */
export type AnyBridgeableMcpTool = import("@sweatpants/core").AnyToolDefinition;

export type InferMcpToolResult<_T> = unknown;
export type InferMcpToolParams<_T> = unknown;
export type InferMcpToolClient<_T> = unknown;
export type InferMcpToolElicits<T> = T extends { readonly elicits: infer E } ? E : never;
