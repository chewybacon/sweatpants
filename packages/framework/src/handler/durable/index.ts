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
export { createDurableChatHandler } from "./handler.ts";

// Alias for consolidation - createChatHandler is the durable handler
export { createDurableChatHandler as createChatHandler } from "./handler.ts";

// Session-contract chat execution adapter
export { createSessionContractChatEngine } from "./session-contract-adapter.ts";

// Replay-crank store context + in-memory development implementation.
export {
  CrankStoreContext,
  useCrankStore,
  useOptionalCrankStore,
  createInMemoryCrankStore,
} from "@sweatpants/session-contract";

// Plugin session manager
export { createPluginSessionManager } from "./plugin-session-manager.ts";
export type {
  PluginSessionManager,
  PluginSession,
  PluginSessionStatus,
  PluginSessionEvent,
  PluginSessionInfo,
  PluginSessionManagerOptions,
  CreatePluginSessionConfig,
} from "./plugin-session-manager.ts";

// Types
export type {
  // Execution adapter types
  SessionContractChatEngine,
  SessionContractChatEngineParams,

  // Tool types
  ToolSchema,

  // Handler types
  DurableChatHandlerConfig,
  ChatHandlerSetupContext,
  ChatHandlerSetup,
  ChatRequestBody,

  // Elicit types
  ElicitResponse,
  PluginAbortRequest,

  // Protocol types
  DurableStreamEvent,
  DurableStreamParams,

  // MCP tool registry
  McpToolRegistry,
} from "./types.ts";
