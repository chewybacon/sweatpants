import type { Operation } from 'effection'
import type { ToolCtx, SamplesMap } from '@sweatpants/core'
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
 * authoring shape. This adapter type intentionally describes the runtime
 * metadata the MCP bridge needs instead of re-declaring a second canonical
 * callable tool ontology.
 */
export type McpRuntimeTool<
  TName extends string = string,
  TParams = unknown,
  THandoff = unknown,
  TClient = unknown,
  TResult = unknown,
  TElicits extends ElicitsMap = ElicitsMap,
  TSamples extends SamplesMap | true | undefined = undefined,
> = {
  readonly name: TName
  readonly description: string
  readonly parameters: z.ZodType<TParams>
  readonly output?: z.ZodType<TResult>
  readonly elicits: TElicits | Record<string, unknown>
  readonly samples?: TSamples extends SamplesMap ? TSamples | Record<string, unknown> : Record<string, unknown>
  readonly schemas?: { readonly input?: z.ZodType<TParams>; readonly output?: z.ZodType<TResult> }
  readonly capabilities?: { readonly elicitation?: boolean; readonly sampling?: boolean }
  readonly annotations?: Readonly<Record<string, unknown>>
  readonly extensions?: readonly unknown[]
  readonly _types?: McpToolTypes<TParams, THandoff, TClient, TResult>
  readonly requires?: { elicitation?: boolean; sampling?: boolean }
  readonly limits?: McpToolLimits
  readonly handoffConfig?: McpToolHandoffConfigWithElicits<TParams, THandoff, TClient, TResult, TElicits>
  readonly execute?: (params: TParams, ctx: ToolCtx<TElicits, TSamples>) => Operation<TResult>
}

export type InferMcpToolResult<T> = T extends McpRuntimeTool<any, any, any, any, infer R, any, any> ? R : never
export type InferMcpToolParams<T> = T extends McpRuntimeTool<any, infer P, any, any, any, any, any> ? P : never
export type InferMcpToolHandoff<T> = T extends McpRuntimeTool<any, any, infer H, any, any, any, any> ? H : never
export type InferMcpToolClient<T> = T extends McpRuntimeTool<any, any, any, infer C, any, any, any> ? C : never
export type InferMcpToolElicits<T> = T extends McpRuntimeTool<any, any, any, any, any, infer E, any> ? E : never
export type AnyMcpTool = McpRuntimeTool<string, any, any, any, any, any, any>
export type AnyBridgeableMcpTool = AnyMcpTool
