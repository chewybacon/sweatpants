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

// Route-independent endpoint factories
export { createDurableChatEndpoints, createDurableChatHandler } from "./handler.ts";
export type {
  DurableChatEndpoints,
  DurableChatProgram,
  DurableChatReadRequest,
  DurableChatStorageInspection,
  DurableHistoryPageRequest,
  HistoryReadAuthorization,
} from "./types.ts";
export { chatStorageFromEnv } from "./storage.ts";
export type { ChatStorageConfig, ChatStorageEnvOptions } from "./storage.ts";
export { resolveDurableChatComposition } from "./configuration.ts";
export type { ResolvedDurableChatComposition } from "./configuration.ts";
export { createProjectionTokenKeyring } from "../projection-tokens.ts";

// Plugin session manager
export { createPluginSessionManager } from "./plugin-session-manager.ts";
export {
  createDevelopmentProgramDriverJournalStore,
  createProgramDriverJournalStore,
  programDriverSchemaRegistry,
} from "./program-driver-journal.ts";
export { programDriverChatEngineSchemaEntries } from "./program-driver-schema.ts";
export {
  createPinnedProgramCatalog,
  createProgramWorkflowHost,
  normalizeProgramTrace,
  runWorkflowProgramActivation,
  verifyPinnedProgramCatalog,
} from "./program-workflow-host.ts";
export type {
  NormalizedProgramOperationTrace,
  NormalizedProgramTaskTrace,
  NormalizedProgramTrace,
  OpenProgramWorkflowRequest,
  PinnedProgramCatalog,
  ProgramCatalogEntry,
  ProgramWorkflowHost,
  ProgramWorkflowHostOptions,
  ProgramWorkflowRun,
  WorkflowProgramActivationScope,
} from "./program-workflow-host.ts";
export {
  createProgramDeliveryWriter,
  highestRemoteOriginLsn,
  projectProgramDeliveryEnvelope,
} from "./model-sampling-relay.ts";
export { ProgramDriverEphemeralEffectsContext } from "../program-driver/effects.ts";
export { createHostModelSamplingService } from "./model-sampling/service.ts";
export {
  ProgramDriverNativeToolsContext,
  nativeProgramIdentities,
  type ProgramDriverNativeToolBinding,
  type ProgramDriverNativeToolComposition,
} from "../program-driver/native-tools.ts";
/** Workflow journal composition contracts. */
export type {
  ProgramDriverJournalStoreOptions,
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
  // Workflow execution types
  WorkflowChatEngine,
  WorkflowChatEngineParams,

  // Tool types
  ToolSchema,

  // Handler types
  DurableChatHandlerConfig,
  DurableChatHandlerOptions,
  DurableChatIdentityConfig,
  DurableChatCompositionConfig,
  ChatHandlerSetupContext,
  ChatHandlerSetup,
  ChatRequestBody,

  // Elicit types
  ElicitResponse,
  PluginAbortRequest,

  // MCP tool registry
  McpToolRegistry,
} from "./types.ts";
