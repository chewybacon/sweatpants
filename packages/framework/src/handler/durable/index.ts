/**
 * Durable Chat Handler
 *
 * Pull-based chat handler with durable streams for:
 * - Client reconnection from last LSN
 * - Multi-client fan-out
 * - Full session replay
 *
 * @module
 */

// Main handler factory
export { createDurableChatHandler } from './handler.ts'

// Alias for consolidation - createChatHandler is the durable handler
export { createDurableChatHandler as createChatHandler } from './handler.ts'

// Chat engine
export { createChatEngine } from './chat-engine.ts'

// Plugin session manager
export { createPluginSessionManager } from './plugin-session-manager.ts'
export type {
  PluginSessionManager,
  PluginSession,
  PluginSessionStatus,
  PluginSessionEvent,
  PluginSessionInfo,
  PluginSessionManagerOptions,
  CreatePluginSessionConfig,
} from './plugin-session-manager.ts'

// Types
export type {
  // Engine types
  EnginePhase,
  ChatEngine,
  ChatEngineParams,

  // Tool types
  ToolCall,
  ToolSchema,
  ToolRegistry,
  IsomorphicTool,
  ToolExecutionResult,
  ElicitRequestData,

  // Client output types
  IsomorphicClientOutput,

  // Handler types
  DurableChatHandlerConfig,
  InitializerContext,
  InitializerHook,
  ChatRequestBody,

  // Elicit types
  ElicitResponse,
  PluginAbortRequest,

  // Protocol types
  DurableStreamEvent,
  DurableStreamParams,

  // MCP tool registry
  McpToolRegistry,
} from './types.ts'
