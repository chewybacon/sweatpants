/**
 * Tool Runtime
 *
 * Re-exports runtime functionality from mcp-tools.
 * The unified builder creates tools compatible with this runtime.
 *
 * @packageDocumentation
 */

// Re-export the core runtime types and functions from mcp-tools
// This provides backward compatibility while we migrate
export {
  // Runtime execution
  createBridgeHost,
  runBridgeTool,
  BranchElicitNotAllowedError,
  type BridgeHost,
  type BridgeEvent,
  type BridgeHostConfig,
  type BridgeSamplingProvider,
  type BridgeSampleOptions,
  type BridgeElicitHandlers,
} from '../../mcp-tools/bridge-runtime.ts'

// Re-export context types
export type {
  McpToolContext,
  McpToolContextWithElicits,
  McpToolServerContext,
} from '../../mcp-tools/mcp-tool-types.ts'

// Re-export sampling/elicitation types
export type {
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SampleToolsResult,
  SampleSchemaResult,
  ElicitResult,
  RawElicitResult,
  ElicitExchange,
  SampleExchange,
} from '../../mcp-tools/mcp-tool-types.ts'

// Re-export errors
export {
  McpToolDepthError,
  McpToolTokenError,
  SampleValidationError,
} from '../../mcp-tools/mcp-tool-types.ts'
