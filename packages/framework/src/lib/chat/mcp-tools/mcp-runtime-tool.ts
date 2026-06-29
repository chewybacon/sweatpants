import type { Operation } from 'effection'
import type { ToolDefinition, ToolCtx } from '@sweatpants/core'
import type { z } from 'zod'
import type { ElicitsMap, McpToolHandoffConfigWithElicits, McpToolLimits } from './mcp-tool-types.ts'

export interface McpToolTypes<in out TParams, in out THandoff, in out TClient, in out TResult> {
  params: TParams
  handoff: THandoff
  client: TClient
  result: TResult
}

/**
 * Runtime MCP adapter input. Canonical core `ToolDefinition` is the preferred
 * shape; optional legacy execution fields remain only so adapter internals can
 * consume already-materialized runtime objects during the migration.
 */
export type McpRuntimeTool<
  TName extends string = string,
  TParams = unknown,
  THandoff = unknown,
  TClient = unknown,
  TResult = unknown,
  TElicits extends ElicitsMap = ElicitsMap,
> = ToolDefinition<TName, TParams, TResult, any, any> & {
  readonly _types?: McpToolTypes<TParams, THandoff, TClient, TResult>
  readonly parameters: z.ZodType<TParams>
  readonly elicits: TElicits | Record<string, unknown>
  readonly requires?: { elicitation?: boolean; sampling?: boolean }
  readonly limits?: McpToolLimits
  readonly handoffConfig?: McpToolHandoffConfigWithElicits<TParams, THandoff, TClient, TResult, TElicits>
  readonly execute?: (params: TParams, ctx: ToolCtx<any, any>) => Operation<TResult>
}

export type InferMcpToolResult<T> = T extends McpRuntimeTool<any, any, any, any, infer R, any> ? R : never
export type InferMcpToolParams<T> = T extends McpRuntimeTool<any, infer P, any, any, any, any> ? P : never
export type InferMcpToolHandoff<T> = T extends McpRuntimeTool<any, any, infer H, any, any, any> ? H : never
export type InferMcpToolClient<T> = T extends McpRuntimeTool<any, any, any, infer C, any, any> ? C : never
export type InferMcpToolElicits<T> = T extends McpRuntimeTool<any, any, any, any, any, infer E> ? E : never
export type AnyMcpTool = McpRuntimeTool<string, any, any, any, any, any>
export type AnyBridgeableMcpTool = AnyMcpTool
