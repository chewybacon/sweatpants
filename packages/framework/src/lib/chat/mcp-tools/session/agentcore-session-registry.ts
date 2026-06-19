import type { Operation, Stream } from 'effection'
import type {
  ToolSession,
  ToolSessionRegistry,
  ToolSessionOptions,
} from './types.ts'
import type { FinalizedMcpToolWithElicits } from '../mcp-tool-builder.ts'
import type { ElicitsMap } from '../mcp-tool-types.ts'
import {
  AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
  type AgentCoreToolEvent,
  type AgentCoreToolRuntimeProfile,
  type AgentCoreToolRuntimeResponse,
  type AgentCoreToolSessionHandle,
  type AgentCoreToolSessionStores,
  type RemoteToolRuntimeClient,
} from './agentcore-types.ts'
import { createAgentCoreToolSession, statusFromAgentCoreToolEvent } from './agentcore-tool-session.ts'

export interface AgentCoreToolSessionRegistryOptions {
  stores: AgentCoreToolSessionStores
  runtimeClient: RemoteToolRuntimeClient<AgentCoreToolSessionHandle>
  profiles: AgentCoreToolRuntimeProfile[]
  defaultProfile?: string
  now?: () => Date
  createRuntimeSessionId?: (sessionId: string, toolName: string) => string
}

function defaultRuntimeSessionId(sessionId: string, toolName: string): string {
  return `sp-tool-${toolName.replace(/[^a-zA-Z0-9_-]+/g, '-')}-${sessionId}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 120)
}

function terminal(event: AgentCoreToolEvent): boolean {
  return event.type === 'result' || event.type === 'error' || event.type === 'cancelled'
}

function terminalStatus(status: AgentCoreToolSessionHandle['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'orphaned'
}

function monotonicSeq(handle: AgentCoreToolSessionHandle, incoming: number): number {
  return Math.max(handle.lastRuntimeEventSeq ?? 0, incoming)
}

export function createAgentCoreToolSessionRegistry(options: AgentCoreToolSessionRegistryOptions): ToolSessionRegistry {
  const { stores, runtimeClient, profiles } = options
  const active = new Map<string, ToolSession>()
  const now = options.now ?? (() => new Date())
  const createRuntimeSessionId = options.createRuntimeSessionId ?? defaultRuntimeSessionId

  function selectProfile(toolName: string): AgentCoreToolRuntimeProfile {
    const preferred = options.defaultProfile
      ? profiles.find((profile) => profile.name === options.defaultProfile && profile.toolNames.includes(toolName))
      : undefined
    const profile = preferred ?? profiles.find((candidate) => candidate.toolNames.includes(toolName))
    if (!profile) throw new Error(`No AgentCore runtime profile allows tool ${toolName}`)
    return profile
  }

  function* ingest(handle: AgentCoreToolSessionHandle, response: AgentCoreToolRuntimeResponse): Operation<AgentCoreToolSessionHandle> {
    if (response.type === 'tool_event') {
      const current = (yield* stores.handles.get(handle.sessionId)) ?? handle
      const lsn = yield* stores.events.appendRemoteEvent(
        handle.sessionId,
        response.runtimeEventSeq,
        response.runtimeEventId,
        response.event
      )
      const isNewer = response.runtimeEventSeq > (current.lastRuntimeEventSeq ?? 0)
      const patch = isNewer && !terminalStatus(current.status) ? statusFromAgentCoreToolEvent(response.event) : {}
      const updated = yield* stores.handles.update(handle.sessionId, {
        ...patch,
        lastEventLsn: Math.max(current.lastEventLsn ?? 0, lsn),
        lastRuntimeEventSeq: monotonicSeq(current, response.runtimeEventSeq),
        updatedAt: now().toISOString(),
      })
      if (terminal(response.event)) yield* stores.events.markTerminal(handle.sessionId)
      return updated
    }

    if (response.type === 'session_status') {
      const current = (yield* stores.handles.get(handle.sessionId)) ?? handle
      const isNewerOrEqual = response.lastRuntimeEventSeq >= (current.lastRuntimeEventSeq ?? 0)
      return yield* stores.handles.update(handle.sessionId, {
        ...(!terminalStatus(current.status) && isNewerOrEqual ? {
          status: response.status,
          pendingRequest: response.pendingRequest,
        } : {}),
        lastRuntimeEventSeq: monotonicSeq(current, response.lastRuntimeEventSeq),
        updatedAt: now().toISOString(),
      })
    }

    if (response.type === 'session_not_found') {
      const current = (yield* stores.handles.get(handle.sessionId)) ?? handle
      if (terminalStatus(current.status)) return current
      const lsn = yield* stores.events.append(handle.sessionId, {
        type: 'error',
        name: 'AgentCoreToolSessionOrphaned',
        message: `AgentCore runtime session did not contain tool session ${response.toolSessionId}`,
      })
      yield* stores.events.markTerminal(handle.sessionId)
      return yield* stores.handles.update(handle.sessionId, {
        status: 'orphaned',
        pendingRequest: undefined,
        lastEventLsn: lsn,
        updatedAt: now().toISOString(),
      })
    }

    if (response.type === 'protocol_error' || response.type === 'command_conflict') {
      const current = (yield* stores.handles.get(handle.sessionId)) ?? handle
      if (terminalStatus(current.status)) return current
      const lsn = yield* stores.events.append(handle.sessionId, {
        type: 'error',
        name: response.type,
        message: response.message,
      })
      yield* stores.events.markTerminal(handle.sessionId)
      return yield* stores.handles.update(handle.sessionId, {
        status: 'failed',
        pendingRequest: undefined,
        lastEventLsn: lsn,
        updatedAt: now().toISOString(),
      })
    }

    if (response.type === 'command_duplicate') {
      const current = (yield* stores.handles.get(handle.sessionId)) ?? handle
      if (terminalStatus(current.status)) return current
      const stream = yield* runtimeClient.drainEvents(current, current.lastRuntimeEventSeq ?? 0)
      const drained = yield* ingestStream(current, stream)
      return yield* ingest(drained, yield* runtimeClient.inspect(drained))
    }

    return handle
  }

  function* ingestStream(handle: AgentCoreToolSessionHandle, stream: Stream<AgentCoreToolRuntimeResponse, void>): Operation<AgentCoreToolSessionHandle> {
    let current = handle
    const sub = yield* stream
    let next = yield* sub.next()
    while (!next.done) {
      current = yield* ingest(current, next.value)
      next = yield* sub.next()
    }
    return current
  }

  function* getSession(sessionId: string): Operation<ToolSession | null> {
    const existing = active.get(sessionId)
    if (existing) return existing
    const handle = yield* stores.handles.get(sessionId)
    if (!handle) return null
    const session = createAgentCoreToolSession({ handle, stores, runtimeClient })
    active.set(sessionId, session)
    return session
  }

  return {
    *create<TParams, THandoff, TClient, TResult, TElicits extends ElicitsMap>(
      tool: FinalizedMcpToolWithElicits<string, TParams, THandoff, TClient, TResult, TElicits>,
      params: TParams,
      sessionOptions?: ToolSessionOptions
    ): Operation<ToolSession<TResult>> {
      const sessionId = sessionOptions?.sessionId ?? `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      const profile = selectProfile(tool.name)
      const startedAt = now()
      const expiresAt = new Date(startedAt.getTime() + profile.maxSessionTtlMs)
      const handle: AgentCoreToolSessionHandle = {
        kind: 'agentcore-tool-session',
        version: 1,
        protocolVersion: AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
        sessionId,
        toolName: tool.name,
        callId: sessionOptions?.sessionId,
        runtimeProfile: profile.name,
        runtimeArn: profile.runtimeArn,
        endpointName: profile.endpointName,
        runtimeSessionId: createRuntimeSessionId(sessionId, tool.name),
        region: profile.region,
        status: 'initializing',
        lastEventLsn: 0,
        lastRuntimeEventSeq: 0,
        createdAt: startedAt.toISOString(),
        updatedAt: startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      }
      yield* stores.handles.create(handle)

      const stream = yield* runtimeClient.start(handle, {
        op: 'start_tool_session',
        protocolVersion: AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
        commandId: `start_${sessionId}`,
        toolSessionId: sessionId,
        toolName: tool.name,
        params,
        context: {
          ...(sessionOptions?.sessionId !== undefined && { callId: sessionOptions.sessionId }),
          ...(sessionOptions?.parentMessages !== undefined && { parentMessages: sessionOptions.parentMessages }),
          ...(sessionOptions?.systemPrompt !== undefined && { systemPrompt: sessionOptions.systemPrompt }),
        },
      })
      const updated = yield* ingestStream(handle, stream)
      const session = createAgentCoreToolSession({ handle: updated, stores, runtimeClient }) as ToolSession<TResult>
      active.set(sessionId, session as ToolSession)
      return session
    },

    *get(sessionId: string): Operation<ToolSession | null> {
      return yield* getSession(sessionId)
    },

    *acquire(sessionId: string): Operation<ToolSession> {
      const session = yield* getSession(sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      yield* session.status()
      return session
    },

    *release(sessionId: string): Operation<void> {
      const handle = yield* stores.handles.get(sessionId)
      if (!handle) {
        active.delete(sessionId)
        return
      }
      if (handle.status === 'completed' || handle.status === 'failed' || handle.status === 'cancelled' || handle.status === 'orphaned') {
        active.delete(sessionId)
      }
    },
  }
}
