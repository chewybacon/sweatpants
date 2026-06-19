import { resource, type Operation, type Stream, type Subscription } from 'effection'
import {
  AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
  type AgentCoreToolRuntimeRequest,
  type AgentCoreToolRuntimeResponse,
  type AgentCoreToolSessionHandle,
  type CancelToolSessionRequest,
  type DrainToolSessionEventsRequest,
  type InspectToolSessionRequest,
  type RemoteToolRuntimeClient,
  type RespondToElicitRequest,
  type RespondToSampleRequest,
  type RuntimeInvokeOptions,
  type StartToolSessionRequest,
} from './agentcore-types.ts'

export interface AgentCoreInvokeInput {
  runtimeArn: string
  endpointName: string
  region: string
  runtimeSessionId: string
  payload: AgentCoreToolRuntimeRequest
  options?: RuntimeInvokeOptions
}

export interface AgentCoreInvoker {
  invoke(input: AgentCoreInvokeInput): Operation<Stream<AgentCoreToolRuntimeResponse, void>>
  stopRuntimeSession?(input: Omit<AgentCoreInvokeInput, 'payload'>): Operation<void>
}

function singleResponseStream(response: AgentCoreToolRuntimeResponse): Stream<AgentCoreToolRuntimeResponse, void> {
  return resource<Subscription<AgentCoreToolRuntimeResponse, void>>(function* (provide) {
    let done = false
    yield* provide({
      *next(): Operation<IteratorResult<AgentCoreToolRuntimeResponse, void>> {
        if (done) return { done: true, value: undefined }
        done = true
        return { done: false, value: response }
      },
    })
  })
}

function baseInput(
  handle: AgentCoreToolSessionHandle,
  payload: AgentCoreToolRuntimeRequest,
  options?: RuntimeInvokeOptions
): AgentCoreInvokeInput {
  return {
    runtimeArn: handle.runtimeArn,
    endpointName: handle.endpointName,
    region: handle.region,
    runtimeSessionId: handle.runtimeSessionId,
    payload,
    ...(options !== undefined && { options }),
  }
}

function inspectPayload(toolSessionId: string, commandId: string): InspectToolSessionRequest {
  return {
    op: 'inspect_tool_session',
    protocolVersion: AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
    commandId,
    toolSessionId,
  }
}

export function createAgentCoreRemoteToolRuntimeClient(
  invoker: AgentCoreInvoker
): RemoteToolRuntimeClient<AgentCoreToolSessionHandle> {
  return {
    *start(handle: AgentCoreToolSessionHandle, request: StartToolSessionRequest, options?: RuntimeInvokeOptions): Operation<Stream<AgentCoreToolRuntimeResponse, void>> {
      return yield* invoker.invoke(baseInput(handle, request, options))
    },

    *respondToElicit(handle: AgentCoreToolSessionHandle, request: RespondToElicitRequest, options?: RuntimeInvokeOptions): Operation<Stream<AgentCoreToolRuntimeResponse, void>> {
      return yield* invoker.invoke(baseInput(handle, request, options))
    },

    *respondToSample(handle: AgentCoreToolSessionHandle, request: RespondToSampleRequest, options?: RuntimeInvokeOptions): Operation<Stream<AgentCoreToolRuntimeResponse, void>> {
      return yield* invoker.invoke(baseInput(handle, request, options))
    },

    *cancel(handle: AgentCoreToolSessionHandle, request: CancelToolSessionRequest, options?: RuntimeInvokeOptions): Operation<Stream<AgentCoreToolRuntimeResponse, void>> {
      return yield* invoker.invoke(baseInput(handle, request, options))
    },

    *inspect(handle: AgentCoreToolSessionHandle, options?: RuntimeInvokeOptions): Operation<AgentCoreToolRuntimeResponse> {
      const stream = yield* invoker.invoke(baseInput(
        handle,
        inspectPayload(handle.sessionId, `inspect_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        options
      ))
      const sub = yield* stream
      const next = yield* sub.next()
      if (next.done) return { type: 'session_not_found', toolSessionId: handle.sessionId }
      return next.value
    },

    *drainEvents(handle: AgentCoreToolSessionHandle, afterRuntimeEventSeq: number, options?: RuntimeInvokeOptions): Operation<Stream<AgentCoreToolRuntimeResponse, void>> {
      const request: DrainToolSessionEventsRequest = {
        op: 'drain_tool_session_events',
        protocolVersion: AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
        commandId: `drain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        toolSessionId: handle.sessionId,
        afterRuntimeEventSeq,
      }
      return yield* invoker.invoke(baseInput(handle, request, options))
    },

    *stopRuntimeSession(handle: AgentCoreToolSessionHandle, options?: RuntimeInvokeOptions): Operation<void> {
      if (!invoker.stopRuntimeSession) return
      yield* invoker.stopRuntimeSession({
        runtimeArn: handle.runtimeArn,
        endpointName: handle.endpointName,
        region: handle.region,
        runtimeSessionId: handle.runtimeSessionId,
        ...(options !== undefined && { options }),
      })
    },
  }
}

export function streamFromAgentCoreResponses(responses: AgentCoreToolRuntimeResponse[]): Stream<AgentCoreToolRuntimeResponse, void> {
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

export function protocolErrorStream(message: string, details?: unknown): Stream<AgentCoreToolRuntimeResponse, void> {
  return singleResponseStream({ type: 'protocol_error', message, ...(details !== undefined && { details }) })
}
