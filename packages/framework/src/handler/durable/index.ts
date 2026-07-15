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

// Replay-crank store context + in-memory development implementation.
export {
  CrankStoreContext,
  useCrankStore,
  useOptionalCrankStore,
  createInMemoryCrankStore,
} from "@sweatpants/session-contract";
/** Re-exported durable persistence port for framework composition. */
export type { CrankStore } from "@sweatpants/session-contract";

// Crank-native authoring/runtime surface. Foreign ToolSession execution remains
// available only through the explicit journaled compatibility boundary.
export {
  DurableEffectRegistryContext,
  JournalAuthority,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramPeer,
  ProgramRuntime,
  FOREIGN_TOOL_ADAPTER_MANIFEST,
  FOREIGN_TOOL_ADAPTER_PROGRAM,
  FOREIGN_TOOL_CONTINUE_EFFECT,
  FOREIGN_TOOL_START_EFFECT,
  foreignToolAdapter,
  createCapabilityKeyring,
  createDurableEffectRegistration,
  createDurableEffectRegistry,
  createDurableTool,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  defineDurableEffect,
  defineDurableProgramManifest,
} from "@sweatpants/session-contract";
/** Crank-native authoring and runtime contracts exposed by the durable handler package. */
export type {
  DurableEffectRegistration,
  DurableProgramContext,
  DurableProgramManifest,
  DurableTool,
  EffectDefinition,
  ForeignDurability,
  ForeignToolDisposition,
  ForeignToolRequest,
  ProgramDriver,
} from "@sweatpants/session-contract";

// Plugin session manager
export { createPluginSessionManager } from "./plugin-session-manager.ts";
export {
  createInMemoryProgramDriverJournalStore,
  programDriverSchemaRegistry,
} from "./program-driver-journal.ts";
export { programDriverChatEngineSchemaEntries } from "./program-driver-chat-engine.ts";
export { ProgramDriverForeignEffectsContext } from "./program-driver-effects.ts";
export {
  ProgramDriverNativeToolsContext,
  nativeProgramIdentities,
  type ProgramDriverNativeToolBinding,
  type ProgramDriverNativeToolComposition,
} from "./program-driver-native-tools.ts";
/** ProgramRuntime journal composition contracts. */
export type {
  InMemoryProgramDriverJournalStoreOptions,
  ProgramDriverJournal,
  ProgramDriverJournalStore,
} from "./program-driver-journal.ts";
/** Plugin-session lifecycle contracts re-exported by the durable handler package. */
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
/** Durable handler request, setup, stream, and tool-inventory contracts. */
export type {
  // ProgramRuntime execution types
  ProgramRuntimeChatEngine,
  ProgramRuntimeChatEngineParams,

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
