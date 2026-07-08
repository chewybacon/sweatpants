export type {
  AnswerPayload,
  AnswerRecord,
  AuthoringMode,
  CallWaitPayload,
  CapabilityDeclaration,
  CapabilityListingEntry,
  CapabilityMap,
  CapabilityResolver,
  CheckpointRecord,
  ConformanceAdapter,
  ElicitWaitPayload,
  EmissionRecord,
  FateRecord,
  FoldSessionHost,
  LogRecord,
  MessageInput,
  MessageWaitPayload,
  ModelProvider,
  PendingWait,
  PostOrphanPolicy,
  ResolutionMeta,
  RespondAck,
  RespondIfPendingResult,
  SampleWaitPayload,
  SendAck,
  Session,
  SessionErrorCode,
  SessionLifecycle,
  SessionStatus,
  Success,
  TerminalOutcome,
  TerminalRecord,
  TypedFailure,
  WaitFate,
  WaitKind,
  WaitPayload,
  WaitPayloadByKind,
  WaitRecord,
} from "./types.ts";

export { SessionContractError } from "./types.ts";
export { deriveLogState, deriveStatus, nextWaitSeq, type DerivedLogState } from "./derive.ts";
export { parseWaitToken, waitToken } from "./token.ts";
export { validateLog, type ValidationResult } from "./validator.ts";
export { assertDeclaredCapability, listCapabilities } from "./capabilities.ts";
export {
  createInMemorySession,
  createSessionContractInMemoryStore,
  restoreInMemorySession,
  type CreateInMemorySessionOptions,
  type InMemorySession,
  type TokenBuffer,
  type TokenBufferStore,
} from "./in-memory-session.ts";
export { createAgent, runOneFoldTurn, type Agent, type AgentConfig } from "./create-agent.ts";
export { spawnFoldDriver } from "./fold-driver.ts";
export {
  createLoopbackResolver,
  type LoopbackResolverOptions,
  type ResolverCallContext,
  type SessionAwareCapabilityResolver,
} from "./loopback.ts";
export {
  CapabilityResolverContext,
  FoldSessionBufferStoreContext,
  ModelProviderContext,
  PostOrphanPolicyContext,
  useCapabilityResolver,
  useFoldSessionBufferStore,
  useModelProvider,
  useOptionalFoldSessionBufferStore,
  usePostOrphanPolicy,
} from "./contexts.ts";

// Projection helpers (AG-UI, task-oriented) have been moved to the
// `@sweatpants/session-contract/projections` subpath export to preserve
// vocabulary discipline: the root contract package exports only the kernel
// grammar and session surface, not protocol-specific projection vocabulary.
