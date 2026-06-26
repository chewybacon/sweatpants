/**
 * @sweatpants/agents — unified agent model.
 *
 * Agents as callable coroutines on a shared durable stream with isomorphic
 * fulfillment. See `.pi/specs/a2a-protocol-support-spec.md`.
 *
 * Stage 1 (this package): AgentEvent vocabulary, AgentSession/stream,
 * createAgent (entry/subAgents/model), AgentCtx (ctx.call/agents/tools/sample/
 * elicit/notify), local fulfillment, parallel(). Stage 2 wires A2A/agentcore
 * transports, the A2A handler, agent-aware MCP, and full snapshot+delta.
 */

// Agent definition
export { createAgent } from './create-agent.ts'
export type {
  AgentConfig,
  AgentFactory,
  AgentInstance,
  AgentInput,
  AgentOutput,
  ModelSelection,
} from './types.ts'

// ctx vocabulary
export {
  buildAgentCtx,
  createRequestRouter,
  effectiveSystemPrompt,
  isAgentFactory,
  isRemoteHandle,
  UnresolvableTargetError,
  generateId,
  type AgentCtx,
  type CompositionTarget,
  type RemoteHandle,
  type RequestRouter,
  type SampleProvider,
  type SampleRequest,
} from './ctx.ts'

// events / commands (canonical vocabulary, REQ-020)
export type {
  AgentEvent,
  AgentEventBase,
  TextDeltaEvent,
  ProgressEvent,
  ToolCallStartEvent,
  ToolCallResultEvent,
  ToolCallEndEvent,
  SubSessionStartEvent,
  SubSessionEndEvent,
  ElicitRequestEvent,
  SampleRequestEvent,
  CheckpointEvent,
  ResultEvent,
  ErrorEvent,
  CancelledEvent,
  AbortedEvent,
  LogEvent,
  AgentMessage,
  AgentState,
  AgentCheckpoint,
  PendingSubSessionRef,
  PendingRequestRef,
  Role,
  LogLevel,
  Message,
  ContentPart,
  ElicitExchange,
  SampleExchange,
  ToolCallExchange,
  AgentCallExchange,
  ToolCallResult,
  AgentCallResult,
  InterruptDescriptor,
  Checkpoint,
  SampleOptions,
  SampleResult,
  ElicitRequest,
  ElicitResult,
  ElicitStatus,
  RawElicitResult,
  IncomingElicitResponse,
  PerCallInterruptOptions,
  DynamicElicitOptions,
} from './events.ts'
export {
  createMessage,
  normalizeContent,
  messageText,
  nextMessageId,
} from './events.ts'
export { isAgentEvent } from './log.ts'

export type {
  AgentCommand,
  SendMessageCommand,
  RespondElicitCommand,
  RespondSampleCommand,
  CancelCommand,
} from './commands.ts'
export { isCommand } from './log.ts'

// stream / session
export {
  createAgentStream,
  createInMemoryAgentStreamStore,
  type AgentStream,
  type AgentStreamStore,
  type Appendable,
} from './stream.ts'
export {
  createAgentSession,
  type AgentSession,
  type CreateAgentSessionOptions,
  type SessionStatus,
} from './session.ts'

// driver
export {
  driveEntry,
  emitCheckpointOp,
  restoreFromCheckpoint,
  type DriveOptions,
} from './driver.ts'

// parallel composition
export { parallel, type ParallelOptions } from './parallel.ts'

// protocol projections
export {
  toAGUIInterrupt,
  elicitResultToAGUIResume,
  aguiResumeToElicitResult,
  toA2AInterruptedTaskStatus,
  toA2ACancelTaskProjection,
  type AGUIInterrupt,
  type AGUIResume,
  type A2ATaskState,
  type A2AInterruptedTaskStatus,
  type A2ACancelTaskProjection,
} from './projections.ts'

// re-export core tool types for authoring convenience
export type {
  AnyToolFactory,
  ToolFromFactory,
  InputFromFactory,
  OutputFromFactory,
} from '@sweatpants/core'

// unified tool model (native builder, migration wrapper, adapters)
export {
  createTool,
  finalizeUnifiedTool,
  normalizeElicits,
  type CreateToolBuilderBase,
  type CreateToolBuilderWithDescription,
  type CreateToolBuilderWithParams,
  type CreateToolBuilderWithElicits,
  type ToolCapabilities,
} from './create-tool.ts'
export { adaptMCPTool, type MCPToolLike, type MCPClientCtxLike, type MCPServerCtxLike } from './adapt-mcp.ts'
export {
  adaptIsomorphicTool,
  type IsomorphicToolLike,
  type IsomorphicClientCtxLike,
  type IsomorphicServerCtxLike,
} from './adapt-isomorphic.ts'
export {
  type ToolCtx,
  type ToolImpl,
  type UnifiedToolFactory,
  type ElicitDefinition,
  type ElicitEntry,
  type ElicitsMap,
  type ExtractElicitResponse,
  type ExtractElicitContext,
  type ExtractElicitResponseSchema,
  type ExtractElicitContextSchema,
  type NormalizedElicitDefinition,
  type NormalizedElicitsMap,
  projectToToolCtx,
} from './tool-ctx.ts'
export { createTool2, type UnifiedToolConfig } from './create-tool2.ts'
