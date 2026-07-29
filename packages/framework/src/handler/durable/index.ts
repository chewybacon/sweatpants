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

// ProgramDriver authoring/runtime surface. Foreign ToolSession execution remains
// available only through the explicit journaled foreign boundary.
export {
  JournalAuthority,
  withJournalAuthority,
  createCapabilityKeyring,
  createInMemoryDurableJournalAuthority,
} from "@sweatpants/session-contract";
export {
  DurableEffectRegistryContext,
  createDurableEffectRegistry,
} from "@sweatpants/durable-effects/runtime";
export {
  FOREIGN_TOOL_ADAPTER_MANIFEST,
  FOREIGN_TOOL_ADAPTER_PROGRAM,
  FOREIGN_TOOL_CONTINUE_EFFECT,
  FOREIGN_TOOL_START_EFFECT,
  foreignToolAdapter,
} from "@sweatpants/tool-session/foreign";
export { defineDurableEffect } from "@sweatpants/durable-effects/authoring";
export {
  ProgramPeer,
  ProgramRuntime,
  createDurableToolRegistry,
} from "@sweatpants/durable-execution";
export {
  createPinnedDurableProgram,
  defineDurableProgramManifest,
} from "@sweatpants/durable-execution";
/** Crank-native authoring and runtime contracts exposed by the durable handler package. */
export type {
  DurableProgramContext,
  DurableProgramManifest,
  DurableTool,
  ForeignDurability,
  ForeignToolDisposition,
  ForeignToolRequest,
} from "@sweatpants/durable-execution";
export type { ProgramDriver } from "@sweatpants/durable-execution";
export type { DurableEffectRegistration, EffectDefinition } from "@sweatpants/durable-effects";

// Plugin session manager
export { createPluginSessionManager } from "./plugin-session-manager.ts";
export {
  createInMemoryProgramDriverJournalStore,
  programDriverSchemaRegistry,
} from "./program-driver-journal.ts";
export { programDriverChatEngineSchemaEntries } from "./program-driver-schema.ts";
export { firstTraceDivergence, runProgramDriverConformance } from "@sweatpants/durable-execution";
export type {
  ProgramDriverConformanceCase,
  ProgramDriverConformanceEvidence,
} from "@sweatpants/durable-execution";
export {
  createLocalProgramHost,
  createPinnedProgramCatalog,
  normalizeProgramTrace,
  runLocalProgramActivation,
  validateCatalog,
} from "./local-program-host.ts";
export type {
  LocalProgramHost,
  LocalProgramActivationScope,
  LocalProgramHostOptions,
  LocalProgramRun,
  NormalizedProgramOperationTrace,
  NormalizedProgramTaskTrace,
  NormalizedProgramTrace,
  OpenLocalProgramRequest,
  PinnedProgramCatalog,
  ProgramCatalogEntry,
} from "./local-program-host.ts";
export {
  createProgramDeliveryWriter,
  highestRemoteOriginLsn,
  projectProgramDeliveryEnvelope,
} from "./model-sampling-relay.ts";
export { ProgramDriverForeignEffectsContext } from "@sweatpants/durable-chat-runtime/program-driver/effects";
export {
  ProgramDriverNativeToolsContext,
  nativeProgramIdentities,
  type ProgramDriverNativeToolBinding,
  type ProgramDriverNativeToolComposition,
} from "@sweatpants/durable-chat-runtime/program-driver/native-tools";
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
