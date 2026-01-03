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
export { createDurableChatHandler } from './handler'

// Chat engine
export { createChatEngine } from './chat-engine'

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

  // Client output types
  IsomorphicClientOutput,

  // Handler types
  DurableChatHandlerConfig,
  InitializerContext,
  InitializerHook,
  ChatRequestBody,

  // Protocol types
  DurableStreamEvent,
  DurableStreamParams,
} from './types'
