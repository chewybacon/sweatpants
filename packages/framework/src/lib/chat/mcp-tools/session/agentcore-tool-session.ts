import { resource, type Operation, type Stream, type Subscription } from 'effection'
import type { ToolSession, ToolSessionEvent, ToolSessionStatus, RawSampleResult } from './types.ts'
import type { RawElicitResult } from '../mcp-tool-types.ts'
import {
  AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
  type AgentCoreToolEvent,
  type AgentCoreToolRuntimeResponse,
  type AgentCoreToolSessionFactoryOptions,
  type AgentCoreToolSessionHandle,
} from './agentcore-types.ts'

function commandId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function toToolSessionEvent(lsn: number, event: AgentCoreToolEvent): ToolSessionEvent {
  return {
    ...event,
    lsn,
    timestamp: Date.now(),
  } as ToolSessionEvent
}

export function statusFromAgentCoreToolEvent(event: AgentCoreToolEvent): Partial<AgentCoreToolSessionHandle> {
  switch (event.type) {
    case 'elicit_request':
      return {
        status: 'awaiting_elicit',
        pendingRequest: { type: 'elicit', elicitId: event.elicitId },
      }
    case 'sample_request':
      return {
        status: 'awaiting_sample',
        pendingRequest: { type: 'sample', sampleId: event.sampleId },
      }
    case 'result':
      return { status: 'completed', pendingRequest: undefined }
    case 'error':
      return { status: 'failed', pendingRequest: undefined }
    case 'cancelled':
      return { status: 'cancelled', pendingRequest: undefined }
    case 'progress':
    case 'log':
      return { status: 'running' }
    default:
      return {}
  }
}

function toToolSessionStatus(status: AgentCoreToolSessionHandle['status']): ToolSessionStatus {
  return status
}

export async function drainAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iterable) result.push(item)
  return result
}

export function createAgentCoreToolSession(options: AgentCoreToolSessionFactoryOptions): ToolSession {
  const { stores, runtimeClient } = options
  const sessionId = options.handle.sessionId
  const toolName = options.handle.toolName

  function* getHandle(): Operation<AgentCoreToolSessionHandle> {
    const handle = yield* stores.handles.get(sessionId)
    if (!handle) throw new Error(`AgentCore tool session not found: ${sessionId}`)
    return handle
  }

  function* markOrphan(reason: string): Operation<void> {
    const handle = yield* getHandle()
    const event: AgentCoreToolEvent = {
      type: 'error',
      name: 'AgentCoreToolSessionOrphaned',
      message: reason,
    }
    const lsn = yield* stores.events.append(sessionId, event)
    yield* stores.events.markTerminal(sessionId)
    yield* stores.handles.update(sessionId, {
      status: 'orphaned',
      pendingRequest: undefined,
      lastEventLsn: lsn,
      updatedAt: new Date().toISOString(),
      lastRuntimeEventSeq: handle.lastRuntimeEventSeq,
    })
  }

  function* ingestResponse(response: AgentCoreToolRuntimeResponse): Operation<void> {
    if (response.type === 'tool_event') {
      const lsn = yield* stores.events.appendRemoteEvent(
        sessionId,
        response.runtimeEventSeq,
        response.runtimeEventId,
        response.event
      )
      const patch = statusFromAgentCoreToolEvent(response.event)
      yield* stores.handles.update(sessionId, {
        ...patch,
        lastEventLsn: lsn,
        lastRuntimeEventSeq: response.runtimeEventSeq,
        updatedAt: new Date().toISOString(),
      })
      if (response.event.type === 'result' || response.event.type === 'error' || response.event.type === 'cancelled') {
        yield* stores.events.markTerminal(sessionId)
      }
      return
    }

    if (response.type === 'session_status') {
      yield* stores.handles.update(sessionId, {
        status: response.status,
        ...(response.pendingRequest !== undefined ? { pendingRequest: response.pendingRequest } : {}),
        lastRuntimeEventSeq: response.lastRuntimeEventSeq,
        updatedAt: new Date().toISOString(),
      })
      return
    }

    if (response.type === 'session_not_found') {
      yield* markOrphan(`AgentCore runtime session did not contain tool session ${response.toolSessionId}`)
      return
    }

    if (response.type === 'protocol_error' || response.type === 'command_conflict') {
      const message = response.type === 'protocol_error' ? response.message : response.message
      const event: AgentCoreToolEvent = { type: 'error', name: response.type, message }
      const lsn = yield* stores.events.append(sessionId, event)
      yield* stores.events.markTerminal(sessionId)
      yield* stores.handles.update(sessionId, {
        status: 'failed',
        pendingRequest: undefined,
        lastEventLsn: lsn,
        updatedAt: new Date().toISOString(),
      })
    }
  }

  function* ingestStream(stream: Stream<AgentCoreToolRuntimeResponse, void>): Operation<void> {
    const subscription = yield* stream
    let next = yield* subscription.next()
    while (!next.done) {
      yield* ingestResponse(next.value)
      next = yield* subscription.next()
    }
  }

  const session: ToolSession = {
    id: sessionId,
    toolName,

    *status(): Operation<ToolSessionStatus> {
      const handle = yield* getHandle()
      return toToolSessionStatus(handle.status)
    },

    events(afterLSN = 0): Stream<ToolSessionEvent, void> {
      return resource<Subscription<ToolSessionEvent, void>>(function* (provide) {
        let cursor = afterLSN
        let buffered: Array<{ lsn: number; event: AgentCoreToolEvent }> = []
        let index = 0

        yield* provide({
          *next(): Operation<IteratorResult<ToolSessionEvent, void>> {
            while (true) {
              if (index < buffered.length) {
                const item = buffered[index++]!
                cursor = item.lsn
                return { done: false, value: toToolSessionEvent(item.lsn, item.event) }
              }

              const batch = yield* stores.events.readAfter(sessionId, cursor)
              buffered = batch.events
              index = 0
              if (buffered.length > 0) continue

              const terminal = yield* stores.events.isTerminal(sessionId)
              if (terminal) return { done: true, value: undefined }

              yield* stores.events.waitForChange(sessionId, cursor)
            }
          },
        })
      })
    },

    *respondToElicit(elicitId: string, response: RawElicitResult<unknown>): Operation<void> {
      const handle = yield* getHandle()
      if (handle.pendingRequest && (handle.pendingRequest.type !== 'elicit' || handle.pendingRequest.elicitId !== elicitId)) {
        throw new Error(`Elicitation ID mismatch: expected ${JSON.stringify(handle.pendingRequest)}, got ${elicitId}`)
      }
      const stream = yield* runtimeClient.respondToElicit(handle, {
        op: 'respond_to_elicit',
        protocolVersion: AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
        commandId: commandId('elicit'),
        toolSessionId: sessionId,
        elicitId,
        response,
      })
      yield* ingestStream(stream)
    },

    *respondToSample(sampleId: string, response: RawSampleResult): Operation<void> {
      const handle = yield* getHandle()
      if (handle.pendingRequest && (handle.pendingRequest.type !== 'sample' || handle.pendingRequest.sampleId !== sampleId)) {
        throw new Error(`Sample ID mismatch: expected ${JSON.stringify(handle.pendingRequest)}, got ${sampleId}`)
      }
      const stream = yield* runtimeClient.respondToSample(handle, {
        op: 'respond_to_sample',
        protocolVersion: AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
        commandId: commandId('sample'),
        toolSessionId: sessionId,
        sampleId,
        response,
      })
      yield* ingestStream(stream)
    },

    *emitWakeUp(): Operation<void> {
      yield* stores.events.waitForChange(sessionId, -1, 0)
    },

    *cancel(reason?: string): Operation<void> {
      const handle = yield* getHandle()
      if (handle.status === 'completed' || handle.status === 'failed' || handle.status === 'cancelled' || handle.status === 'orphaned') {
        return
      }
      const stream = yield* runtimeClient.cancel(handle, {
        op: 'cancel_tool_session',
        protocolVersion: AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
        commandId: commandId('cancel'),
        toolSessionId: sessionId,
        ...(reason !== undefined && { reason }),
      })
      yield* ingestStream(stream)
    },
  }

  return session
}
