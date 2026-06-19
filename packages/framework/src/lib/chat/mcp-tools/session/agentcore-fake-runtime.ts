import { resource, type Operation, type Stream, type Subscription } from 'effection'
import type { RawElicitResult } from '../mcp-tool-types.ts'
import type { RawSampleResult } from './types.ts'
import type {
  AgentCoreToolEvent,
  AgentCoreToolRuntimeResponse,
  AgentCoreToolSessionHandle,
  CancelToolSessionRequest,
  RemoteToolRuntimeClient,
  RespondToElicitRequest,
  RespondToSampleRequest,
  RuntimeInvokeOptions,
  StartToolSessionRequest,
} from './agentcore-types.ts'

interface FakeSession {
  toolSessionId: string
  toolName: string
  status: AgentCoreToolSessionHandle['status']
  pending?:
    | { type: 'elicit'; elicitId: string }
    | { type: 'sample'; sampleId: string }
    | undefined
  nextSeq: number
  events: Array<{ seq: number; id: string; event: AgentCoreToolEvent }>
  acceptedCommands: Map<string, string>
}

function streamFromResponses(responses: AgentCoreToolRuntimeResponse[]): Stream<AgentCoreToolRuntimeResponse, void> {
  return resource<Subscription<AgentCoreToolRuntimeResponse, void>>(function* (provide) {
    let index = 0
    yield* provide({
      *next(): Operation<IteratorResult<AgentCoreToolRuntimeResponse, void>> {
        if (index >= responses.length) return { done: true, value: undefined }
        return { done: false, value: responses[index++]! }
      },
    })
  })
}

function eventResponse(session: FakeSession, event: AgentCoreToolEvent): AgentCoreToolRuntimeResponse {
  const seq = session.nextSeq++
  const id = `${session.toolSessionId}:${seq}`
  session.events.push({ seq, id, event })
  return { type: 'tool_event', toolSessionId: session.toolSessionId, runtimeEventSeq: seq, runtimeEventId: id, event }
}

function statusResponse(session: FakeSession): AgentCoreToolRuntimeResponse {
  return {
    type: 'session_status',
    toolSessionId: session.toolSessionId,
    status: session.status,
    ...(session.pending !== undefined && { pendingRequest: session.pending }),
    lastRuntimeEventSeq: session.nextSeq - 1,
  }
}

function commandFingerprint(request: object): string {
  return JSON.stringify(request)
}

export class FakeAgentCoreRemoteToolRuntimeClient implements RemoteToolRuntimeClient<AgentCoreToolSessionHandle> {
  readonly sessions = new Map<string, FakeSession>()
  readonly invocations: Array<{ op: string; runtimeSessionId: string; request: unknown }> = []

  start: RemoteToolRuntimeClient<AgentCoreToolSessionHandle>['start'] = function* (
    this: FakeAgentCoreRemoteToolRuntimeClient,
    handle: AgentCoreToolSessionHandle,
    request: StartToolSessionRequest,
    _options?: RuntimeInvokeOptions
  ) {
    this.invocations.push({ op: request.op, runtimeSessionId: handle.runtimeSessionId, request })
    const existing = this.sessions.get(request.toolSessionId)
    if (existing) return streamFromResponses([{ type: 'command_duplicate', toolSessionId: request.toolSessionId, commandId: request.commandId, originalStatus: 'accepted' }])

    const session: FakeSession = {
      toolSessionId: request.toolSessionId,
      toolName: request.toolName,
      status: 'running',
      nextSeq: 1,
      events: [],
      acceptedCommands: new Map([[request.commandId, commandFingerprint(request)]]),
    }
    this.sessions.set(request.toolSessionId, session)

    const responses: AgentCoreToolRuntimeResponse[] = []
    responses.push(eventResponse(session, { type: 'progress', message: `started ${request.toolName}`, progress: 0 }))

    if (request.toolName.includes('elicit')) {
      const elicitId = `${request.toolSessionId}:elicit:1`
      session.status = 'awaiting_elicit'
      session.pending = { type: 'elicit', elicitId }
      responses.push(eventResponse(session, {
        type: 'elicit_request',
        elicitId,
        key: 'confirm',
        message: 'Confirm?',
        schema: { type: 'object' },
      }))
      responses.push(statusResponse(session))
      return streamFromResponses(responses)
    }

    if (request.toolName.includes('sample')) {
      const sampleId = `${request.toolSessionId}:sample:1`
      session.status = 'awaiting_sample'
      session.pending = { type: 'sample', sampleId }
      responses.push(eventResponse(session, {
        type: 'sample_request',
        sampleId,
        messages: [{ role: 'user', content: 'Say hello' }],
      }))
      responses.push(statusResponse(session))
      return streamFromResponses(responses)
    }

    if (request.toolName.includes('error')) {
      session.status = 'failed'
      responses.push(eventResponse(session, { type: 'error', name: 'FakeToolError', message: 'fake failure' }))
      responses.push(statusResponse(session))
      return streamFromResponses(responses)
    }

    session.status = 'completed'
    responses.push(eventResponse(session, { type: 'result', result: { ok: true, toolName: request.toolName, params: request.params } }))
    responses.push(statusResponse(session))
    return streamFromResponses(responses)
  }

  respondToElicit: RemoteToolRuntimeClient<AgentCoreToolSessionHandle>['respondToElicit'] = function* (
    this: FakeAgentCoreRemoteToolRuntimeClient,
    handle: AgentCoreToolSessionHandle,
    request: RespondToElicitRequest,
    _options?: RuntimeInvokeOptions
  ) {
    this.invocations.push({ op: request.op, runtimeSessionId: handle.runtimeSessionId, request })
    const session = this.sessions.get(request.toolSessionId)
    if (!session) return streamFromResponses([{ type: 'session_not_found', toolSessionId: request.toolSessionId }])
    const duplicate = this.checkDuplicate(session, request.commandId, request)
    if (duplicate) return streamFromResponses([duplicate])
    if (!session.pending || session.pending.type !== 'elicit' || session.pending.elicitId !== request.elicitId) {
      return streamFromResponses([{ type: 'command_conflict', toolSessionId: request.toolSessionId, commandId: request.commandId, message: 'not awaiting matching elicit' }])
    }
    session.acceptedCommands.set(request.commandId, commandFingerprint(request))
    session.pending = undefined
    session.status = 'completed'
    const response = request.response as RawElicitResult<unknown>
    const result = response.action === 'accept' ? response.content : { action: response.action }
    return streamFromResponses([
      eventResponse(session, { type: 'result', result }),
      statusResponse(session),
    ])
  }

  respondToSample: RemoteToolRuntimeClient<AgentCoreToolSessionHandle>['respondToSample'] = function* (
    this: FakeAgentCoreRemoteToolRuntimeClient,
    handle: AgentCoreToolSessionHandle,
    request: RespondToSampleRequest,
    _options?: RuntimeInvokeOptions
  ) {
    this.invocations.push({ op: request.op, runtimeSessionId: handle.runtimeSessionId, request })
    const session = this.sessions.get(request.toolSessionId)
    if (!session) return streamFromResponses([{ type: 'session_not_found', toolSessionId: request.toolSessionId }])
    const duplicate = this.checkDuplicate(session, request.commandId, request)
    if (duplicate) return streamFromResponses([duplicate])
    if (!session.pending || session.pending.type !== 'sample' || session.pending.sampleId !== request.sampleId) {
      return streamFromResponses([{ type: 'command_conflict', toolSessionId: request.toolSessionId, commandId: request.commandId, message: 'not awaiting matching sample' }])
    }
    session.acceptedCommands.set(request.commandId, commandFingerprint(request))
    session.pending = undefined
    session.status = 'completed'
    const response = request.response as RawSampleResult
    return streamFromResponses([
      eventResponse(session, { type: 'result', result: { text: response.text } }),
      statusResponse(session),
    ])
  }

  cancel: RemoteToolRuntimeClient<AgentCoreToolSessionHandle>['cancel'] = function* (
    this: FakeAgentCoreRemoteToolRuntimeClient,
    handle: AgentCoreToolSessionHandle,
    request: CancelToolSessionRequest,
    _options?: RuntimeInvokeOptions
  ) {
    this.invocations.push({ op: request.op, runtimeSessionId: handle.runtimeSessionId, request })
    const session = this.sessions.get(request.toolSessionId)
    if (!session) return streamFromResponses([{ type: 'session_not_found', toolSessionId: request.toolSessionId }])
    session.status = 'cancelled'
    session.pending = undefined
    return streamFromResponses([
      eventResponse(session, { type: 'cancelled', ...(request.reason !== undefined && { reason: request.reason }) }),
      statusResponse(session),
    ])
  }

  inspect: RemoteToolRuntimeClient<AgentCoreToolSessionHandle>['inspect'] = function* (
    this: FakeAgentCoreRemoteToolRuntimeClient,
    handle: AgentCoreToolSessionHandle,
    _options?: RuntimeInvokeOptions
  ) {
    const session = this.sessions.get(handle.sessionId)
    if (!session) return { type: 'session_not_found', toolSessionId: handle.sessionId }
    return statusResponse(session)
  }

  drainEvents: RemoteToolRuntimeClient<AgentCoreToolSessionHandle>['drainEvents'] = function* (
    this: FakeAgentCoreRemoteToolRuntimeClient,
    handle: AgentCoreToolSessionHandle,
    afterRuntimeEventSeq: number,
    _options?: RuntimeInvokeOptions
  ) {
    const session = this.sessions.get(handle.sessionId)
    if (!session) return streamFromResponses([{ type: 'session_not_found', toolSessionId: handle.sessionId }])
    return streamFromResponses(session.events
      .filter((event) => event.seq > afterRuntimeEventSeq)
      .map((event) => ({
        type: 'tool_event' as const,
        toolSessionId: session.toolSessionId,
        runtimeEventSeq: event.seq,
        runtimeEventId: event.id,
        event: event.event,
      })))
  }

  stopRuntimeSession: RemoteToolRuntimeClient<AgentCoreToolSessionHandle>['stopRuntimeSession'] = function* () {
    // no-op for fake runtime
  }

  private checkDuplicate(session: FakeSession, commandId: string, request: object): AgentCoreToolRuntimeResponse | null {
    const previous = session.acceptedCommands.get(commandId)
    if (!previous) return null
    if (previous === commandFingerprint(request)) {
      return { type: 'command_duplicate', toolSessionId: session.toolSessionId, commandId, originalStatus: 'accepted' }
    }
    return { type: 'command_conflict', toolSessionId: session.toolSessionId, commandId, message: 'commandId reused with different payload' }
  }
}
