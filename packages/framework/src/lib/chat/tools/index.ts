/**
 * Unified Tool System
 *
 * This module provides a unified API for creating tools that can:
 * - Execute server-side logic
 * - Sample from LLMs (single-turn and multi-turn)
 * - Elicit user input via typed UI components
 * - Coordinate server↔client handoff
 *
 * @example Simple tool
 * ```typescript
 * import { createTool } from '@sweatpants/framework/chat/tools'
 * import { z } from 'zod'
 *
 * const calculator = createTool('calculator')
 *   .description('Calculate expression')
 *   .parameters(z.object({ expr: z.string() }))
 *   .execute(function*(params) {
 *     return { result: eval(params.expr) }
 *   })
 * ```
 *
 * @example Tool with sampling
 * ```typescript
 * const greet = createTool('greet')
 *   .description('Generate greeting')
 *   .parameters(z.object({ name: z.string() }))
 *   .execute(function*(params, ctx) {
 *     const result = yield* ctx.sample({ prompt: `Hello ${params.name}` })
 *     return { greeting: result.text }
 *   })
 * ```
 *
 * @example Tool with elicitation
 * ```typescript
 * const pickCard = createTool('pick_card')
 *   .description('Pick a card')
 *   .parameters(z.object({}))
 *   .elicit('pick', z.object({ card: z.string() }))
 *   .handoff({
 *     *before() { return { cards: ['A', 'K', 'Q'] } },
 *     *client(handoff, ctx) {
 *       const result = yield* ctx.elicit('pick', { message: 'Pick', cards: handoff.cards })
 *       if (result.action !== 'accept') return { cancelled: true }
 *       return { picked: result.content.card }
 *     },
 *     *after(handoff, client) {
 *       if ('cancelled' in client) return { error: 'Cancelled' }
 *       return { selected: client.picked }
 *     }
 *   })
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// BUILDER
// =============================================================================

export { createTool } from './builder.ts'
export type {
  ToolBuilderBase,
  ToolBuilderWithDescription,
  ToolBuilderWithParams,
  ToolBuilderWithElicits,
} from './builder.ts'

// =============================================================================
// TYPES
// =============================================================================

export type {
  // Elicitation
  ElicitsMap,
  InferElicitResponse,
  ElicitResult,
  ElicitData,

  // Sampling
  Message,
  ToolCall,
  SampleConfig,
  SampleConfigPrompt,
  SampleConfigMessages,
  SampleResult,
  SampleSchemaConfig,
  SampleSchemaResult,
  SamplingToolDefinition,
  SampleToolsConfig,
  SampleToolsResult,

  // Logging
  LogLevel,

  // Context
  ToolLimits,
  ToolContextBase,
  ServerToolContext,
  ToolContextWithSampling,
  ToolContextWithElicits,
  ToolContext,

  // Tool types
  ToolTypes,
  HandoffConfig,
  ExecuteFn,
  ToolMode,
  FinalizedTool,
  AnyTool,

  // Type helpers
  InferToolName,
  InferToolParams,
  InferToolHandoff,
  InferToolClient,
  InferToolResult,
  InferToolElicits,

  // Schema
  ToolSchema,
} from './types.ts'

// =============================================================================
// ADAPTERS
// =============================================================================

export { toMcpTool, isUnifiedTool } from './adapters/mcp.ts'

// =============================================================================
// RUNTIME (re-exported from mcp-tools)
// =============================================================================

export {
  createBridgeHost,
  runBridgeTool,
  BranchElicitNotAllowedError,
  McpToolDepthError,
  McpToolTokenError,
  SampleValidationError,
} from './runtime/index.ts'

export type {
  BridgeHost,
  BridgeEvent,
  BridgeHostConfig,
  BridgeSamplingProvider,
  BridgeSampleOptions,
  BridgeElicitHandlers,
  McpToolContext,
  McpToolContextWithElicits,
  McpToolServerContext,
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  ElicitExchange,
  SampleExchange,
  RawElicitResult,
} from './runtime/index.ts'

// =============================================================================
// PLUGIN SYSTEM
// =============================================================================

export {
  makePlugin,
  createPluginRegistryFrom,
} from './plugin.ts'

export type {
  PluginBuilder,
  PluginClientContext,
  PluginClientRegistration,
  PluginClientRegistrationInput,
  PluginServerRegistration,
  ElicitHandler,
  ElicitHandlers,
  RenderableProps,
  UserProps,
  ExtractResponse,
  PluginRegistry,
} from './plugin.ts'
