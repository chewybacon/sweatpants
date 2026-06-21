import type { Operation, Stream } from 'effection'
import type {
  ToolSession,
  ToolSessionStatus,
  ToolSessionEvent,
  RawSampleResult,
} from '@sweatpants/framework/chat/mcp-tools'
import type { RawElicitResult, ExtendedMessage } from '@sweatpants/framework/chat/mcp-tools'

export const AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION = 'sweatpants.agentcore.tool-session.v1' as const

export type AgentCoreToolSessionTerminalStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned'

export type AgentCoreToolSessionStatus = ToolSessionStatus | 'orphaned'

export interface AgentCoreToolSessionHandle {
  kind: 'agentcore-tool-session'
  version: 1
  protocolVersion: typeof AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION

  sessionId: string
  toolName: string
  callId?: string | undefined
  conversationId?: string | undefined

  runtimeProfile: string
  runtimeArn: string
  endpointName: string
  runtimeSessionId: string
  region: string

  status: AgentCoreToolSessionStatus
  pendingRequest?:
    | { type: 'elicit'; elicitId: string }
    | { type: 'sample'; sampleId: string }
    | undefined

  lastEventLsn: number
  lastRuntimeEventSeq: number
  createdAt: string
  updatedAt: string
  expiresAt: string

  stopRequestedAt?: string | undefined
  stoppedAt?: string | undefined

  metadata?: {
    tenantId?: string | undefined
    userId?: string | undefined
    toolPackageVersion?: string | undefined
    imageDigest?: string | undefined
  } | undefined
}

export type AgentCoreToolEvent = ToolSessionEvent extends infer Event
  ? Event extends unknown
    ? Omit<Event, 'lsn' | 'timestamp'>
    : never
  : never

export interface StoredToolSessionEvent {
  sessionId: string
  lsn: number
  runtimeEventSeq: number
  runtimeEventId: string
  timestamp: string
  event: AgentCoreToolEvent
}

interface AgentCoreToolRuntimeRequestBase {
  protocolVersion: typeof AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION
  commandId: string
  toolSessionId: string
}

export interface StartToolSessionRequest extends AgentCoreToolRuntimeRequestBase {
  op: 'start_tool_session'
  toolName: string
  params: unknown
  context?: {
    conversationId?: string
    callId?: string
    parentMessages?: ExtendedMessage[]
    systemPrompt?: string
  }
}

export interface RespondToElicitRequest extends AgentCoreToolRuntimeRequestBase {
  op: 'respond_to_elicit'
  elicitId: string
  response: RawElicitResult<unknown>
}

export interface RespondToSampleRequest extends AgentCoreToolRuntimeRequestBase {
  op: 'respond_to_sample'
  sampleId: string
  response: RawSampleResult
}

export interface CancelToolSessionRequest extends AgentCoreToolRuntimeRequestBase {
  op: 'cancel_tool_session'
  reason?: string
}

export interface InspectToolSessionRequest extends AgentCoreToolRuntimeRequestBase {
  op: 'inspect_tool_session'
}

export interface DrainToolSessionEventsRequest extends AgentCoreToolRuntimeRequestBase {
  op: 'drain_tool_session_events'
  afterRuntimeEventSeq: number
}

export type AgentCoreToolRuntimeRequest =
  | StartToolSessionRequest
  | RespondToElicitRequest
  | RespondToSampleRequest
  | CancelToolSessionRequest
  | InspectToolSessionRequest
  | DrainToolSessionEventsRequest

export type AgentCoreToolRuntimeResponse =
  | {
      type: 'tool_event'
      toolSessionId: string
      runtimeEventSeq: number
      runtimeEventId: string
      event: AgentCoreToolEvent
    }
  | {
      type: 'session_status'
      toolSessionId: string
      status: AgentCoreToolSessionStatus
      pendingRequest?: AgentCoreToolSessionHandle['pendingRequest']
      lastRuntimeEventSeq: number
    }
  | { type: 'session_not_found'; toolSessionId: string }
  | { type: 'command_duplicate'; toolSessionId: string; commandId: string; originalStatus: 'accepted' | 'rejected' }
  | { type: 'command_conflict'; toolSessionId: string; commandId: string; message: string }
  | { type: 'protocol_error'; message: string; details?: unknown }

export interface RuntimeInvokeOptions {
  timeoutMs?: number
  retry?: { maxAttempts: number; baseDelayMs: number }
  signal?: AbortSignal
}

export interface SerializableToolSessionHandleStore<THandle> {
  create(handle: THandle): Operation<void>
  get(sessionId: string): Operation<THandle | null>
  update(sessionId: string, patch: Partial<THandle>): Operation<THandle>
  delete(sessionId: string): Operation<void>
  findByCallId(callId: string): Operation<THandle | null>
  listByConversation(conversationId: string): Operation<THandle[]>
}

export interface ToolSessionEventStore<TEvent> {
  append(sessionId: string, event: TEvent): Operation<number>
  appendRemoteEvent(sessionId: string, runtimeEventSeq: number, runtimeEventId: string, event: TEvent): Operation<number>
  readAfter(sessionId: string, afterLSN?: number): Operation<{ events: Array<{ lsn: number; event: TEvent }>; lastLSN: number }>
  waitForChange(sessionId: string, afterLSN: number, timeoutMs?: number): Operation<void>
  markTerminal(sessionId: string): Operation<void>
  isTerminal(sessionId: string): Operation<boolean>
}

export interface RemoteToolRuntimeClient<THandle> {
  start(handle: THandle, request: StartToolSessionRequest, options?: RuntimeInvokeOptions): Operation<Stream<AgentCoreToolRuntimeResponse, void>>
  respondToElicit(handle: THandle, request: RespondToElicitRequest, options?: RuntimeInvokeOptions): Operation<Stream<AgentCoreToolRuntimeResponse, void>>
  respondToSample(handle: THandle, request: RespondToSampleRequest, options?: RuntimeInvokeOptions): Operation<Stream<AgentCoreToolRuntimeResponse, void>>
  cancel(handle: THandle, request: CancelToolSessionRequest, options?: RuntimeInvokeOptions): Operation<Stream<AgentCoreToolRuntimeResponse, void>>
  inspect(handle: THandle, options?: RuntimeInvokeOptions): Operation<AgentCoreToolRuntimeResponse>
  drainEvents(handle: THandle, afterRuntimeEventSeq: number, options?: RuntimeInvokeOptions): Operation<Stream<AgentCoreToolRuntimeResponse, void>>
  stopRuntimeSession(handle: THandle, options?: RuntimeInvokeOptions): Operation<void>
}

export interface AgentCoreToolRuntimeProfile {
  name: string
  runtimeArn: string
  endpointName: string
  region: string
  toolNames: string[]
  maxSessionTtlMs: number
  idleTimeoutMs?: number
}

export interface AgentCoreToolSessionStores {
  handles: SerializableToolSessionHandleStore<AgentCoreToolSessionHandle>
  events: ToolSessionEventStore<AgentCoreToolEvent>
}

export interface AgentCoreToolSessionFactoryOptions {
  handle: AgentCoreToolSessionHandle
  stores: AgentCoreToolSessionStores
  runtimeClient: RemoteToolRuntimeClient<AgentCoreToolSessionHandle>
}

export type AgentCoreToolSession = ToolSession
