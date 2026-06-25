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
  ToolCallEndEvent,
  SubSessionStartEvent,
  SubSessionEndEvent,
  ElicitRequestEvent,
  SampleRequestEvent,
  CheckpointEvent,
  ResultEvent,
  ErrorEvent,
  CancelledEvent,
  AgentMessage,
  AgentState,
  AgentCheckpoint,
  PendingSubSessionRef,
  PendingRequestRef,
  SampleOptions,
  SampleResult,
  ElicitRequest,
  ElicitResult,
  ElicitStatus,
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

// re-export core tool types for authoring convenience
export type {
  AnyToolFactory,
  ToolFromFactory,
  InputFromFactory,
  OutputFromFactory,
} from '@sweatpants/core'
