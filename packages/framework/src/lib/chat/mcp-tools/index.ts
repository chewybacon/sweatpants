/**
 * MCP Tools Module
 *
 * Generator-based primitives for authoring MCP (Model Context Protocol) tools.
 *
 * ## Two Builders
 *
 * - `createMCPTool`: Original builder with MCPClientContext (simpler)
 * - `createBranchTool`: Branch-based builder with sub-branching support
 *
 * @example Simple tool (original)
 * ```typescript
 * import { createMCPTool } from '@grove/framework/mcp-tools'
 *
 * const calculator = createMCPTool('calculate')
 *   .description('Perform a calculation')
 *   .parameters(z.object({ expression: z.string() }))
 *   .execute(function*(params) {
 *     return { result: evaluate(params.expression) }
 *   })
 * ```
 *
 * @example Branch-based tool with sub-branches
 * ```typescript
 * import { createBranchTool } from '@grove/framework/mcp-tools'
 *
 * const analyze = createBranchTool('analyze')
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
// ORIGINAL MCP BUILDER (simpler, no sub-branching)
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
  ElicitResult,
  ElicitConfig,
  SampleConfig,
  ModelPreferences,
  LogLevel,
  InferMCPToolParams,
  InferMCPToolResult,
  InferMCPToolHandoff,
  InferMCPToolClient,
} from './types'

// Errors (shared)
export {
  MCPCapabilityError,
  ElicitationDeclinedError,
  ElicitationCancelledError,
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
// BRANCH-BASED BUILDER (sub-branching, context tracking)
// =============================================================================

export { createBranchTool } from './branch-builder'
export type {
  BranchToolBuilderBase,
  BranchToolBuilderWithDescription,
  BranchToolBuilderWithParams,
  BranchToolBuilderWithElicits,
  FinalizedBranchTool,
  FinalizedBranchToolWithElicits,
  BranchToolTypes,
  InferBranchResult,
  InferBranchParams,
  InferBranchHandoff,
  InferBranchClient,
  InferBranchElicits,
  AnyBranchTool,
  AnyBridgeableBranchTool,
} from './branch-builder'

// Branch types
export type {
  BranchContext,
  BranchContextWithElicits,
  BranchHandoffConfig,
  BranchHandoffConfigWithElicits,
  BranchServerContext,
  BranchOptions,
  BranchLimits,
  BranchSampleConfig,
  SampleConfigPrompt,
  SampleConfigMessages,
  SampleResult,
  Message,
  MessageRole,
  ElicitsMap,
  ElicitId,
  ElicitRequest,
} from './branch-types'

// Branch errors
export {
  BranchDepthError,
  BranchTokenError,
  BranchTimeoutError,
} from './branch-types'

// Branch runtime
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
