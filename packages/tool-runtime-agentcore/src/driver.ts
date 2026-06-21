import { resource, type Operation, type Stream } from 'effection'
import {
  ToolRuntimeContext,
  ToolRuntimeError,
  createToolExecutionRef,
  type ElicitToolRequest,
  type StartToolCallRequest,
  type ToolCall,
  type ToolDefinition,
  type ToolExecuteRequest,
  type ToolExecution,
  type ToolExecutionEvent,
  type ToolExecutionRef,
  type ToolInventoryEntry,
  type ToolResumeRequest,
  type ToolRuntime,
  type ToolRuntimeToolSchema,
  type ToolSession as RuntimeToolSession,
  type ToolSessionEvent as RuntimeToolSessionEvent,
  type ToolSessionRef,
} from '@sweatpants/framework/chat'
import type {
  ElicitsMap,
  FinalizedMcpToolWithElicits,
  ToolSession as McpToolSession,
  ToolSessionEvent as McpToolSessionEvent,
  ToolSessionRegistry,
} from '@sweatpants/framework/chat/mcp-tools'
import { createAgentCoreToolSessionRegistry, type AgentCoreToolSessionRegistryOptions } from './agentcore-session-registry.ts'

type AgentCoreRuntimeTool = FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>

type AgentCoreImplementation = { kind: 'agentcore'; tool: AgentCoreRuntimeTool }

export interface AgentCoreToolRuntimeDriverOptions {
  /** Stable runtime identifier stored on all execution refs. */
  id?: string
  /** Executable tool contracts allowed through this runtime. */
  tools: AgentCoreRuntimeTool[]
  /** Existing AgentCore registry. If omitted, registryOptions are used to create one. */
  registry?: ToolSessionRegistry
  /** Options for creating the AgentCore session registry. */
  registryOptions?: AgentCoreToolSessionRegistryOptions
}

function parametersToSchema(parameters: unknown): Record<string, unknown> {
  if (parameters && typeof parameters === 'object' && typeof (parameters as { toJSONSchema?: unknown }).toJSONSchema === 'function') {
    return (parameters as { toJSONSchema: () => Record<string, unknown> }).toJSONSchema()
  }
  return parameters && typeof parameters === 'object'
    ? (parameters as Record<string, unknown>)
    : { type: 'object', properties: {}, required: [] }
}

function toDefinition(tool: AgentCoreRuntimeTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: parametersToSchema(tool.parameters),
  }
}

export function createAgentCoreToolInventoryEntry(tool: AgentCoreRuntimeTool, metadata?: Record<string, unknown>): ToolInventoryEntry<AgentCoreImplementation> {
  return {
    definition: toDefinition(tool),
    implementation: { kind: 'agentcore', tool },
    capabilities: { remote: true, session: true, elicits: true, samples: true },
    ...(metadata ? { metadata } : {}),
  }
}

function toToolSchema(tool: AgentCoreRuntimeTool): ToolRuntimeToolSchema {
  return toDefinition(tool)
}

function adaptEvent(event: McpToolSessionEvent): RuntimeToolSessionEvent {
  return event as unknown as RuntimeToolSessionEvent
}

function adaptSession(runtimeId: string, session: McpToolSession): RuntimeToolSession {
  return {
    id: session.id,
    runtimeId,
    toolName: session.toolName,
    events(afterLSN?: number): Stream<RuntimeToolSessionEvent, void> {
      const source = session.events(afterLSN)
      return resource(function* (provide) {
        const subscription = yield* source
        yield* provide({
          *next(): Operation<IteratorResult<RuntimeToolSessionEvent, void>> {
            const next = yield* subscription.next()
            if (next.done) return { done: true, value: undefined }
            return { done: false, value: adaptEvent(next.value) }
          },
        })
      })
    },
  }
}

function eventStreamFromSession(session: RuntimeToolSession): Stream<ToolExecutionEvent, void> {
  return resource(function* (provide) {
    const subscription = yield* session.events()
    yield* provide({
      *next(): Operation<IteratorResult<ToolExecutionEvent, void>> {
        return (yield* subscription.next()) as IteratorResult<ToolExecutionEvent, void>
      },
    })
  })
}

function sessionEventToExecution(runtimeId: string, call: ToolCall, session: RuntimeToolSession, event: RuntimeToolSessionEvent | null): ToolExecution {
  const ref = createToolExecutionRef({ runtimeId, executionId: session.id, sessionId: session.id, callId: call.id, toolName: session.toolName })
  if (!event) {
    return { kind: 'failed', ref, error: { code: 'SESSION_ENDED', message: 'AgentCore tool session ended unexpectedly' } }
  }

  switch (event.type) {
    case 'elicit_request':
      return {
        kind: 'awaiting_elicit',
        ref,
        request: {
          elicitId: String(event.elicitId),
          key: String((event as { key?: unknown }).key ?? ''),
          message: String((event as { message?: unknown }).message ?? ''),
          schema: ((event as { schema?: unknown }).schema && typeof (event as { schema?: unknown }).schema === 'object')
            ? (event as { schema: Record<string, unknown> }).schema
            : { type: 'object', properties: {}, required: [] },
        } satisfies ElicitToolRequest,
      }
    case 'result':
      return { kind: 'completed', ref, result: (event as { result: unknown }).result }
    case 'error':
      return { kind: 'failed', ref, error: { code: 'TOOL_ERROR', message: String((event as { message?: unknown }).message ?? 'AgentCore tool failed') } }
    case 'cancelled':
      return { kind: 'failed', ref, error: { code: 'TOOL_CANCELLED', message: String((event as { reason?: unknown }).reason ?? 'AgentCore tool execution was cancelled') } }
    default:
      return { kind: 'running', ref, events: eventStreamFromSession(session) }
  }
}

function isAgentCoreImplementation(value: unknown): value is AgentCoreImplementation {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'agentcore'
}

export function createAgentCoreToolRuntimeDriver(
  options: AgentCoreToolRuntimeDriverOptions,
): ToolRuntime & {
  listTools(): Operation<ToolRuntimeToolSchema[]>
  startToolCall(request: StartToolCallRequest): Operation<RuntimeToolSession>
  getSession(ref: ToolSessionRef): Operation<RuntimeToolSession | null>
  respondToElicit(ref: ToolSessionRef, elicitId: string, response: unknown): Operation<void>
  abortSession(ref: ToolSessionRef, reason?: string): Operation<void>
} {
  const runtimeId = options.id ?? 'agentcore'
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool] as const))
  const registry = options.registry ?? (options.registryOptions
    ? createAgentCoreToolSessionRegistry(options.registryOptions)
    : undefined)
  if (!registry) {
    throw new Error('AgentCore tool runtime requires registry or registryOptions')
  }

  const startSession = function* (request: StartToolCallRequest): Operation<RuntimeToolSession> {
    const tool = toolsByName.get(request.toolName)
    if (!tool) {
      throw new ToolRuntimeError('TOOL_NOT_FOUND', `Tool not found in AgentCore runtime: ${request.toolName}`)
    }
    const session = yield* registry.create(tool, request.arguments, {
      sessionId: request.callId,
      ...(request.signal ? { signal: request.signal } : {}),
    })
    return adaptSession(runtimeId, session)
  }

  return {
    id: runtimeId,

    *listTools(): Operation<ToolRuntimeToolSchema[]> {
      return Array.from(toolsByName.values()).map(toToolSchema)
    },

    *startToolCall(request: StartToolCallRequest): Operation<RuntimeToolSession> {
      return yield* startSession(request)
    },

    *getSession(ref: ToolSessionRef): Operation<RuntimeToolSession | null> {
      if (ref.runtimeId !== runtimeId) return null
      const session = yield* registry.get(ref.id)
      if (!session) return null
      if (session.toolName !== ref.toolName) return null
      return adaptSession(runtimeId, session)
    },

    *respondToElicit(ref: ToolSessionRef, elicitId: string, response: unknown): Operation<void> {
      const session = yield* registry.get(ref.id)
      if (!session) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `AgentCore tool session not found: ${ref.id}`)
      yield* session.respondToElicit(elicitId, response as never)
    },

    *abortSession(ref: ToolSessionRef, reason?: string): Operation<void> {
      const session = yield* registry.get(ref.id)
      if (!session) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `AgentCore tool session not found: ${ref.id}`)
      yield* session.cancel(reason)
    },

    *execute(request: ToolExecuteRequest): Operation<ToolExecution> {
      const implementation = request.entry.implementation
      const tool = isAgentCoreImplementation(implementation)
        ? implementation.tool
        : toolsByName.get(request.call.function.name)
      if (!tool) {
        throw new ToolRuntimeError('NO_MATCHING_TOOL_STRATEGY', `AgentCore runtime cannot execute tool: ${request.call.function.name}`)
      }
      const session = yield* startSession({
        toolName: tool.name,
        callId: request.call.id,
        arguments: request.call.function.arguments,
        ...(request.signal ? { signal: request.signal } : {}),
      })
      const subscription = yield* session.events()
      const next = yield* subscription.next()
      return sessionEventToExecution(runtimeId, request.call, session, next.done ? null : next.value)
    },

    *resume(request: ToolResumeRequest): Operation<ToolExecution> {
      const sessionId = request.ref.sessionId ?? request.ref.executionId
      const session = yield* registry.get(sessionId)
      if (!session) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `AgentCore tool session not found: ${sessionId}`)
      if (request.ref.toolName && session.toolName !== request.ref.toolName) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `AgentCore tool session not found: ${sessionId}`)

      if (request.input.type === 'elicit_response') {
        if (!request.input.elicitId) throw new ToolRuntimeError('ELICIT_ID_REQUIRED', 'Elicit continuation requires elicitId')
        yield* session.respondToElicit(request.input.elicitId, request.input.result as never)
      }

      const runtimeSession = adaptSession(runtimeId, session)
      const subscription = yield* runtimeSession.events()
      const next = yield* subscription.next()
      return sessionEventToExecution(runtimeId, { id: request.ref.callId, type: 'function', function: { name: request.ref.toolName, arguments: {} } }, runtimeSession, next.done ? null : next.value)
    },

    *abort(ref: ToolExecutionRef, reason?: string): Operation<void> {
      const sessionId = ref.sessionId ?? ref.executionId
      const session = yield* registry.get(sessionId)
      if (!session) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `AgentCore tool session not found: ${sessionId}`)
      yield* session.cancel(reason)
    },
  }
}

export function* installAgentCoreToolRuntime(
  options: AgentCoreToolRuntimeDriverOptions,
): Operation<ToolRuntime> {
  const driver = createAgentCoreToolRuntimeDriver(options)
  yield* ToolRuntimeContext.set(driver)
  return driver
}
