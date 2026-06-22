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
  type ToolExecutionContext,
  type ToolExecutionEvent,
  type ToolExecutionRef,
  type ToolExecutionStrategy,
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
  ToolSessionSamplingProvider,
} from '@sweatpants/framework/chat/mcp-tools'
import { createAgentCoreToolSessionRegistry, type AgentCoreToolSessionRegistryOptions } from './agentcore-session-registry.ts'

type AgentCoreRuntimeTool = FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>

type AgentCoreImplementation = { kind: 'agentcore'; tool: AgentCoreRuntimeTool }
type AgentCoreContextModelSelection = { provider: string; id: string }

export interface AgentCoreToolRuntimeDriverOptions {
  /** Stable runtime identifier stored on all execution refs. */
  id?: string
  /** Executable tool contracts allowed through this runtime. */
  tools: AgentCoreRuntimeTool[]
  /** Existing AgentCore registry. If omitted, registryOptions are used to create one. */
  registry?: ToolSessionRegistry
  /** Sampling provider used when remote tools emit sample_request events. */
  samplingProvider: ToolSessionSamplingProvider
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

function modelSelectionFromMetadata(metadata: Record<string, unknown> | undefined): AgentCoreContextModelSelection | undefined {
  const model = metadata?.['model']
  if (!model || typeof model !== 'object' || Array.isArray(model)) return undefined
  const provider = (model as { provider?: unknown }).provider
  const id = (model as { id?: unknown }).id
  if (typeof provider !== 'string' || provider.trim().length === 0) return undefined
  if (typeof id !== 'string' || id.trim().length === 0) return undefined
  return { provider: provider.trim(), id: id.trim() }
}

function afterLsnFromPendingId(id: string | undefined): number | undefined {
  if (!id) return undefined

  const requestMatch = /:req:(\d+)$/.exec(id)
  if (requestMatch?.[1]) return Number(requestMatch[1])

  const elicitMatch = /:elicit:(\d+)$/.exec(id)
  if (elicitMatch?.[1]) return Number(elicitMatch[1]) + 1

  const sampleMatch = /:sample:(\d+)$/.exec(id)
  if (sampleMatch?.[1]) return Number(sampleMatch[1]) + 1

  return undefined
}

function* findPendingRequestLsn(session: McpToolSession, pendingId: string | undefined): Operation<number | undefined> {
  if (!pendingId) return undefined

  const subscription = yield* session.events()
  while (true) {
    const next = yield* subscription.next()
    if (next.done) return undefined
    const event = next.value
    if (event.type === 'elicit_request' && String(event.elicitId) === pendingId) return event.lsn
    if (event.type === 'sample_request' && String(event.sampleId) === pendingId) return event.lsn
  }
}

function* nextAgentCoreExecution(
  runtimeId: string,
  call: ToolCall,
  session: McpToolSession,
  samplingProvider: ToolSessionSamplingProvider,
  afterLSN?: number,
): Operation<ToolExecution> {
  const runtimeSession = adaptSession(runtimeId, session)
  const subscription = yield* session.events(afterLSN)

  while (true) {
    const next = yield* subscription.next()
    if (next.done) return sessionEventToExecution(runtimeId, call, runtimeSession, null)

    if (next.value.type === 'sample_request') {
      const result = yield* samplingProvider.sample(next.value.messages, {
        ...(next.value.systemPrompt ? { systemPrompt: next.value.systemPrompt } : {}),
        ...(next.value.maxTokens !== undefined ? { maxTokens: next.value.maxTokens } : {}),
        ...(next.value.tools ? { tools: next.value.tools } : {}),
        ...(next.value.toolChoice ? { toolChoice: next.value.toolChoice } : {}),
        ...(next.value.schema ? { schema: next.value.schema } : {}),
      })
      yield* session.respondToSample(next.value.sampleId, result)
      continue
    }

    if (next.value.type === 'progress' || next.value.type === 'log' || next.value.type === 'sample_response_queued') {
      continue
    }

    return sessionEventToExecution(runtimeId, call, runtimeSession, next.value as unknown as RuntimeToolSessionEvent)
  }
}

export interface AgentCoreToolExecutionStrategyOptions {
  id?: string
  registry: ToolSessionRegistry
  samplingProvider: ToolSessionSamplingProvider
  tools: AgentCoreRuntimeTool[]
}

export function createAgentCoreToolExecutionStrategy(
  options: AgentCoreToolExecutionStrategyOptions,
): ToolExecutionStrategy {
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool] as const))
  return {
    id: options.id ?? 'agentcore-session',
    canExecute(entry, call) {
      if (isAgentCoreImplementation(entry.implementation)) return true
      return toolsByName.has(call.function.name)
    },
    *execute(entry, call, ctx: ToolExecutionContext): Operation<ToolExecution> {
      const tool = isAgentCoreImplementation(entry.implementation)
        ? entry.implementation.tool
        : toolsByName.get(call.function.name)
      if (!tool) throw new ToolRuntimeError('NO_MATCHING_TOOL_STRATEGY', `AgentCore strategy cannot execute tool: ${call.function.name}`)
      const selectedModel = modelSelectionFromMetadata(ctx.metadata)
      const session = yield* options.registry.create(tool, call.function.arguments, {
        sessionId: call.id,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
      })
      return yield* nextAgentCoreExecution(ctx.runtimeId, call, session, options.samplingProvider)
    },
    *resume(ref, input, ctx: ToolExecutionContext): Operation<ToolExecution> {
      const sessionId = ref.sessionId ?? ref.executionId
      const session = yield* options.registry.get(sessionId)
      if (!session) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `AgentCore tool session not found: ${sessionId}`)
      if (ref.toolName && session.toolName !== ref.toolName) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `AgentCore tool session not found: ${sessionId}`)
      const pendingId = input.type === 'elicit_response' ? input.elicitId : undefined
      const pendingLsn = yield* findPendingRequestLsn(session, pendingId)
      if (input.type === 'elicit_response') {
        if (!input.elicitId) throw new ToolRuntimeError('ELICIT_ID_REQUIRED', 'Elicit continuation requires elicitId')
        yield* session.respondToElicit(input.elicitId, input.result as never)
      }
      return yield* nextAgentCoreExecution(
        ctx.runtimeId,
        { id: ref.callId, type: 'function', function: { name: ref.toolName || session.toolName, arguments: {} } },
        session,
        options.samplingProvider,
        pendingLsn ?? afterLsnFromPendingId(pendingId),
      )
    },
    *abort(ref, reason): Operation<void> {
      const sessionId = ref.sessionId ?? ref.executionId
      const session = yield* options.registry.get(sessionId)
      if (!session) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `AgentCore tool session not found: ${sessionId}`)
      yield* session.cancel(reason)
    },
  }
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
      const selectedModel = modelSelectionFromMetadata(request.metadata)
      const session = yield* registry.create(tool, request.call.function.arguments, {
        sessionId: request.call.id,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
      })
      return yield* nextAgentCoreExecution(runtimeId, request.call, session, options.samplingProvider)
    },

    *resume(request: ToolResumeRequest): Operation<ToolExecution> {
      const sessionId = request.ref.sessionId ?? request.ref.executionId
      const session = yield* registry.get(sessionId)
      if (!session) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `AgentCore tool session not found: ${sessionId}`)
      if (request.ref.toolName && session.toolName !== request.ref.toolName) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `AgentCore tool session not found: ${sessionId}`)

      const pendingId = request.input.type === 'elicit_response' ? request.input.elicitId : undefined
      const pendingLsn = yield* findPendingRequestLsn(session, pendingId)
      if (request.input.type === 'elicit_response') {
        if (!request.input.elicitId) throw new ToolRuntimeError('ELICIT_ID_REQUIRED', 'Elicit continuation requires elicitId')
        yield* session.respondToElicit(request.input.elicitId, request.input.result as never)
      }

      return yield* nextAgentCoreExecution(
        runtimeId,
        { id: request.ref.callId, type: 'function', function: { name: request.ref.toolName || session.toolName, arguments: {} } },
        session,
        options.samplingProvider,
        pendingLsn ?? afterLsnFromPendingId(pendingId),
      )
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
