/**
 * MCP Tools Module
 *
 * Generator-based primitives for authoring MCP (Model Context Protocol) tools.
 *
 * ## Primary API (NEW - use these)
 *
 * - `createMcpTool`: Unified builder with branching, sampling, and elicitation
 *
 * ## Legacy API (DEPRECATED - will be removed)
 *
 * - `createMCPTool`: Original builder with MCPClientContext (simpler, no branching)
 * - `createBranchTool`: Old name for createMcpTool
 *
 * @example Using the primary API
 * ```typescript
 * import { createMcpTool } from '@grove/framework/mcp-tools'
 *
 * const analyze = createMcpTool('analyze')
 *   .description('Analyze with sub-branches')
 *   .parameters(z.object({ input: z.string() }))
 *   .execute(function*(params, ctx) {
 *     // Auto-tracked conversation
 *     const first = yield* ctx.sample({ prompt: 'First step...' })
 *
 *     // Sub-branch for isolated task
 *     const detail = yield* ctx.branch(function* (subCtx) {
 *       return yield* subCtx.sample({ prompt: 'Detail...' })
 *     }, { inheritMessages: false })
 *
 *     return { first: first.text, detail: detail.text }
 *   })
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// PRIMARY API (NEW UNIFIED TYPES AND BUILDER)
// =============================================================================

export { createMcpTool } from './mcp-tool-builder'
export type {
  // Builder interfaces
  McpToolBuilderBase,
  McpToolBuilderWithDescription,
  McpToolBuilderWithParams,
  McpToolBuilderWithElicits,
  FinalizedMcpTool,
  FinalizedMcpToolWithElicits,
  McpToolTypes,
  // Type inference helpers
  InferMcpToolResult,
  InferMcpToolParams,
  InferMcpToolHandoff,
  InferMcpToolClient,
  InferMcpToolElicits,
  // Union types
  AnyMcpTool,
  AnyBridgeableMcpTool,
} from './mcp-tool-builder'

// Types from unified types file
export type {
  // Context types
  McpToolContext,
  McpToolContextWithElicits,
  McpToolServerContext,
  // Handoff configuration
  McpToolHandoffConfig,
  McpToolHandoffConfigWithElicits,
  // Branch options and limits
  McpToolBranchOptions,
  McpToolLimits,
  // Sample types
  McpToolSampleConfig,
  SampleConfigPrompt,
  SampleConfigMessages,
  SampleResult,
  // Message types
  Message,
  MessageRole,
  // Elicitation types
  ElicitResult,
  ElicitConfig,
  ElicitsMap,
  ElicitId,
  ElicitRequest,
  // Logging
  LogLevel,
  ModelPreferences,
} from './mcp-tool-types'

// Errors from unified types file
export {
  McpCapabilityError,
  ElicitationDeclinedError,
  ElicitationCancelledError,
  McpToolDepthError,
  McpToolTokenError,
  McpToolTimeoutError,
  McpDisconnectError,
} from './mcp-tool-types'

// =============================================================================
// LEGACY ALIASES (for backward compatibility during migration)
// Branch* -> McpTool* mapping
// =============================================================================

// Re-export createMcpTool as createBranchTool for backward compatibility
export { createMcpTool as createBranchTool } from './mcp-tool-builder'

// Re-export builder types with legacy names
export type {
  McpToolBuilderBase as BranchToolBuilderBase,
  McpToolBuilderWithDescription as BranchToolBuilderWithDescription,
  McpToolBuilderWithParams as BranchToolBuilderWithParams,
  McpToolBuilderWithElicits as BranchToolBuilderWithElicits,
  FinalizedMcpTool as FinalizedBranchTool,
  FinalizedMcpToolWithElicits as FinalizedBranchToolWithElicits,
  McpToolTypes as BranchToolTypes,
  InferMcpToolResult as InferBranchResult,
  InferMcpToolParams as InferBranchParams,
  InferMcpToolHandoff as InferBranchHandoff,
  InferMcpToolClient as InferBranchClient,
  InferMcpToolElicits as InferBranchElicits,
  AnyMcpTool as AnyBranchTool,
  AnyBridgeableMcpTool as AnyBridgeableBranchTool,
} from './mcp-tool-builder'

// Re-export context/config types with legacy names
export type {
  McpToolContext as BranchContext,
  McpToolContextWithElicits as BranchContextWithElicits,
  McpToolServerContext as BranchServerContext,
  McpToolHandoffConfig as BranchHandoffConfig,
  McpToolHandoffConfigWithElicits as BranchHandoffConfigWithElicits,
  McpToolBranchOptions as BranchOptions,
  McpToolLimits as BranchLimits,
  McpToolSampleConfig as BranchSampleConfig,
} from './mcp-tool-types'

// Re-export errors with legacy names
export {
  McpToolDepthError as BranchDepthError,
  McpToolTokenError as BranchTokenError,
  McpToolTimeoutError as BranchTimeoutError,
} from './mcp-tool-types'

// =============================================================================
// ORIGINAL MCP BUILDER (simpler, no sub-branching) - DEPRECATED
// =============================================================================

export { createMCPTool } from './builder'
export type {
  MCPToolBuilderBase,
  MCPToolBuilderWithDescription,
  MCPToolBuilderWithParams,
  FinalizedMCPTool,
  MCPToolTypes,
  InferMCPResult,
  InferMCPParams,
  InferMCPHandoff,
  InferMCPClient,
} from './builder'

// Original types
export type {
  MCPClientContext,
  MCPServerContext,
  MCPHandoffConfig,
  MCPToolDef,
  AnyMCPTool,
  // Note: ElicitResult and ElicitConfig are already exported from mcp-tool-types
  // These are aliases for backward compat
  // ElicitResult,
  // ElicitConfig,
  SampleConfig,
  // ModelPreferences already exported above
  // LogLevel already exported above
  InferMCPToolParams,
  InferMCPToolResult,
  InferMCPToolHandoff,
  InferMCPToolClient,
} from './types'

// Legacy errors (shared) - keep for compatibility
export {
  MCPCapabilityError,
  // ElicitationDeclinedError already exported above
  // ElicitationCancelledError already exported above
  MCPTimeoutError,
  MCPDisconnectError,
} from './types'

// Original mock runtime
export {
  createMockMCPClient,
  runMCPTool,
  runMCPToolOrThrow,
} from './mock-runtime'
export type {
  MockMCPClient,
  MockMCPClientConfig,
  RunMCPToolOptions,
} from './mock-runtime'

// =============================================================================
// BRANCH RUNTIME (uses new types internally)
// =============================================================================

export { runBranchTool } from './branch-runtime'
export type {
  BranchMCPClient,
  RunBranchToolOptions,
} from './branch-runtime'

// Branch mock runtime
export {
  createMockBranchClient,
  runBranchToolMock,
} from './branch-mock'
export type {
  MockBranchClient,
  MockBranchClientConfig,
} from './branch-mock'

// =============================================================================
// PLUGIN SYSTEM (bridgeable tools -> framework-native plugins)
// =============================================================================

export { makePlugin } from './plugin'
export type {
  McpPlugin,
  PluginBuilder,
  PluginBuilderWithHandlers,
  PluginServerRegistration,
  PluginClientRegistration,
  PluginClientContext,
  ElicitHandler,
  ElicitHandlers,
  InferPluginElicits,
  InferPluginTool,
  AnyMcpPlugin,
} from './plugin'

// =============================================================================
// BRIDGE RUNTIME (in-app tool execution with UI elicitation)
// =============================================================================

export {
  createBridgeHost,
  runBridgeTool,
  BranchElicitNotAllowedError,
} from './bridge-runtime'
export type {
  BridgeHost,
  BridgeHostConfig,
  BridgeEvent,
  BridgeSamplingProvider,
  BridgeElicitHandlers,
  ElicitResponse,
} from './bridge-runtime'
