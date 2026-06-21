import { resource, type Operation, type Stream } from 'effection'
import {
  ToolRuntimeContext,
  ToolRuntimeError,
  createToolExecutionRef,
  type ClientToolRequest,
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
import { HandoffReadyError, type ServerAuthorityContext, type ServerToolContext } from '@sweatpants/framework/chat/isomorphic-tools'
import type {
  ElicitsMap,
  FinalizedMcpToolWithElicits,
  ToolSession as McpToolSession,
  ToolSessionEvent as McpToolSessionEvent,
  ToolSessionRegistry,
  ToolSessionSamplingProvider,
  ToolSessionStore,
} from '@sweatpants/framework/chat/mcp-tools'
import { createInMemoryToolSessionStore } from './in-memory-store.ts'
import { createToolSessionRegistry, type ToolSessionRegistryOptions } from './session-registry.ts'

type LocalRuntimeTool = FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>

type LocalImplementation =
  | { kind: 'mcp'; tool: LocalRuntimeTool }
  | { kind: 'isomorphic'; tool: LocalIsomorphicTool }

export interface LocalIsomorphicTool {
  name: string
  description: string
  parameters: { parse?: (input: unknown) => unknown } | Record<string, unknown>
  server?: (params: unknown, ctx: unknown, clientOutput?: unknown) => Operation<unknown>
  client?: (input: unknown, ctx: unknown, params: unknown) => Operation<unknown>
}

export interface LocalToolRuntimeDriverOptions {
  /** Stable runtime identifier stored on all execution refs. */
  id?: string
  /** Executable MCP tools owned by this local runtime. */
  tools?: LocalRuntimeTool[]
  /** Isomorphic inline/client tools owned by this local runtime. */
  isomorphicTools?: LocalIsomorphicTool[]
  /** Existing long-lived registry. If omitted, one is created from store/samplingProvider. */
  registry?: ToolSessionRegistry
  /** Store used when creating a registry. Defaults to in-memory. */
  store?: ToolSessionStore
  /** Sampling provider used when tools call ctx.sample(); required unless registry is supplied. */
  samplingProvider?: ToolSessionSamplingProvider
  /** Registry defaults used when creating a registry. */
  registryOptions?: Omit<ToolSessionRegistryOptions, 'samplingProvider'>
}

function parametersToSchema(parameters: unknown): Record<string, unknown> {
  if (parameters && typeof parameters === 'object' && typeof (parameters as { toJSONSchema?: unknown }).toJSONSchema === 'function') {
    return (parameters as { toJSONSchema: () => Record<string, unknown> }).toJSONSchema()
  }
  return parameters && typeof parameters === 'object'
    ? (parameters as Record<string, unknown>)
    : { type: 'object', properties: {}, required: [] }
}

function mcpToolDefinition(tool: LocalRuntimeTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: parametersToSchema(tool.parameters),
  }
}

function isomorphicToolDefinition(tool: LocalIsomorphicTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: parametersToSchema(tool.parameters),
  }
}

export function createMcpToolInventoryEntry(tool: LocalRuntimeTool, metadata?: Record<string, unknown>): ToolInventoryEntry<LocalImplementation> {
  return {
    definition: mcpToolDefinition(tool),
    implementation: { kind: 'mcp', tool },
    capabilities: { session: true, worker: true, elicits: true, samples: true },
    ...(metadata ? { metadata } : {}),
  }
}

export function createIsomorphicToolInventoryEntry(tool: LocalIsomorphicTool, metadata?: Record<string, unknown>): ToolInventoryEntry<LocalImplementation> {
  return {
    definition: isomorphicToolDefinition(tool),
    implementation: { kind: 'isomorphic', tool },
    capabilities: {
      inline: !!tool.server,
      client: !!tool.client,
    },
    ...(metadata ? { metadata } : {}),
  }
}

function toToolSchema(tool: LocalRuntimeTool | LocalIsomorphicTool): ToolRuntimeToolSchema {
  return 'elicits' in tool ? mcpToolDefinition(tool) : isomorphicToolDefinition(tool)
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

function createPhase1Context(baseContext: ServerToolContext): ServerAuthorityContext {
  return {
    ...baseContext,
    *handoff(config) {
      const handoffData = yield* config.before()
      throw new HandoffReadyError(handoffData)
    },
  }
}

function validateParams(tool: LocalIsomorphicTool, params: unknown): unknown {
  const parser = tool.parameters as { parse?: (input: unknown) => unknown }
  if (typeof parser.parse !== 'function') return params
  try {
    return parser.parse(params)
  } catch {
    return params
  }
}

function isLocalImplementation(value: unknown): value is LocalImplementation {
  return !!value && typeof value === 'object' && 'kind' in value
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

function mcpEventToExecution(runtimeId: string, call: ToolCall, session: RuntimeToolSession, event: RuntimeToolSessionEvent | null): ToolExecution {
  const ref = createToolExecutionRef({ runtimeId, executionId: session.id, sessionId: session.id, callId: call.id, toolName: session.toolName })
  if (!event) {
    return { kind: 'failed', ref, error: { code: 'SESSION_ENDED', message: 'Tool session ended unexpectedly' } }
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
        },
      }
    case 'result':
      return { kind: 'completed', ref, result: (event as { result: unknown }).result }
    case 'error':
      return { kind: 'failed', ref, error: { code: 'TOOL_ERROR', message: String((event as { message?: unknown }).message ?? 'Tool failed') } }
    case 'cancelled':
      return { kind: 'failed', ref, error: { code: 'TOOL_CANCELLED', message: String((event as { reason?: unknown }).reason ?? 'Tool execution was cancelled') } }
    default:
      return { kind: 'running', ref, events: eventStreamFromSession(session) }
  }
}

function* nextMcpExecution(
  runtimeId: string,
  call: ToolCall,
  session: McpToolSession,
  samplingProvider: ToolSessionSamplingProvider,
): Operation<ToolExecution> {
  const runtimeSession = adaptSession(runtimeId, session)
  const subscription = yield* session.events()

  while (true) {
    const next = yield* subscription.next()
    if (next.done) return mcpEventToExecution(runtimeId, call, runtimeSession, null)

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

    if (
      next.value.type === 'progress' ||
      next.value.type === 'log' ||
      next.value.type === 'sample_response_queued'
    ) {
      continue
    }

    return mcpEventToExecution(runtimeId, call, runtimeSession, next.value as unknown as RuntimeToolSessionEvent)
  }
}

export function* createLocalToolRuntimeDriver(
  options: LocalToolRuntimeDriverOptions,
): Operation<ToolRuntime & {
  listTools(): Operation<ToolRuntimeToolSchema[]>
  startToolCall(request: StartToolCallRequest): Operation<RuntimeToolSession>
  getSession(ref: ToolSessionRef): Operation<RuntimeToolSession | null>
  respondToElicit(ref: ToolSessionRef, elicitId: string, response: unknown): Operation<void>
  abortSession(ref: ToolSessionRef, reason?: string): Operation<void>
}> {
  const runtimeId = options.id ?? 'local'
  const mcpToolsByName = new Map((options.tools ?? []).map((tool) => [tool.name, tool] as const))
  const isomorphicToolsByName = new Map((options.isomorphicTools ?? []).map((tool) => [tool.name, tool] as const))
  const samplingProvider = options.samplingProvider ?? {
    *sample() {
      throw new Error('Local tool runtime sampling provider not configured')
    },
  }
  const registry = options.registry ?? (yield* createToolSessionRegistry(
    options.store ?? createInMemoryToolSessionStore(),
    {
      ...(options.registryOptions ?? {}),
      samplingProvider,
    },
  ))

  const startMcpSession = function* (request: StartToolCallRequest): Operation<RuntimeToolSession> {
    const tool = mcpToolsByName.get(request.toolName)
    if (!tool) {
      throw new ToolRuntimeError('TOOL_NOT_FOUND', `Tool not found in local runtime: ${request.toolName}`)
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
      return [
        ...Array.from(isomorphicToolsByName.values()).map(toToolSchema),
        ...Array.from(mcpToolsByName.values()).map(toToolSchema),
      ]
    },

    *startToolCall(request: StartToolCallRequest): Operation<RuntimeToolSession> {
      return yield* startMcpSession(request)
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
      if (!session) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `Local tool session not found: ${ref.id}`)
      yield* session.respondToElicit(elicitId, response as never)
    },

    *abortSession(ref: ToolSessionRef, reason?: string): Operation<void> {
      const session = yield* registry.get(ref.id)
      if (!session) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `Local tool session not found: ${ref.id}`)
      yield* session.cancel(reason)
    },

    *execute(request: ToolExecuteRequest): Operation<ToolExecution> {
      const implementation = request.entry.implementation
      const toolName = request.call.function.name
      if (isLocalImplementation(implementation) && implementation.kind === 'isomorphic') {
        const tool = implementation.tool
        const ref = createToolExecutionRef({ runtimeId, callId: request.call.id, toolName })
        const params = validateParams(tool, request.call.function.arguments)
        if (!tool.server) {
          if (tool.client) {
            return { kind: 'awaiting_client', ref, request: { params, usesHandoff: false } satisfies ClientToolRequest }
          }
          return { kind: 'failed', ref, error: { code: 'TOOL_NOT_EXECUTABLE', message: `Tool "${toolName}" has no server or client function` } }
        }

        try {
          const ctx = createPhase1Context({ callId: request.call.id, signal: request.signal ?? new AbortController().signal })
          const serverOutput = yield* tool.server(params, ctx)
          if (tool.client) {
            return { kind: 'awaiting_client', ref, request: { params, serverOutput, usesHandoff: true } satisfies ClientToolRequest }
          }
          return { kind: 'completed', ref, result: serverOutput }
        } catch (error) {
          if (error instanceof HandoffReadyError) {
            return { kind: 'awaiting_client', ref, request: { params, serverOutput: error.handoffData, usesHandoff: true } satisfies ClientToolRequest }
          }
          return { kind: 'failed', ref, error: { code: 'TOOL_ERROR', message: error instanceof Error ? error.message : String(error) } }
        }
      }

      const mcpTool = isLocalImplementation(implementation) && implementation.kind === 'mcp'
        ? implementation.tool
        : mcpToolsByName.get(toolName)
      if (!mcpTool) {
        throw new ToolRuntimeError('NO_MATCHING_TOOL_STRATEGY', `Local runtime cannot execute tool: ${toolName}`)
      }

      const session = yield* registry.create(mcpTool, request.call.function.arguments, {
        sessionId: request.call.id,
        ...(request.signal ? { signal: request.signal } : {}),
      })
      return yield* nextMcpExecution(runtimeId, request.call, session, samplingProvider)
    },

    *resume(request: ToolResumeRequest): Operation<ToolExecution> {
      const sessionId = request.ref.sessionId ?? request.ref.executionId
      const session = yield* registry.get(sessionId)
      if (!session) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `Local tool session not found: ${sessionId}`)
      if (request.ref.toolName && session.toolName !== request.ref.toolName) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `Local tool session not found: ${sessionId}`)

      if (request.input.type === 'elicit_response') {
        if (!request.input.elicitId) throw new ToolRuntimeError('ELICIT_ID_REQUIRED', 'Elicit continuation requires elicitId')
        yield* session.respondToElicit(request.input.elicitId, request.input.result as never)
      }

      return yield* nextMcpExecution(
        runtimeId,
        { id: request.ref.callId, type: 'function', function: { name: request.ref.toolName || session.toolName, arguments: {} } },
        session,
        samplingProvider,
      )
    },

    *abort(ref: ToolExecutionRef, reason?: string): Operation<void> {
      const sessionId = ref.sessionId ?? ref.executionId
      const session = yield* registry.get(sessionId)
      if (!session) throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `Local tool session not found: ${sessionId}`)
      yield* session.cancel(reason)
    },
  }
}

export function* installLocalToolRuntime(
  options: LocalToolRuntimeDriverOptions,
): Operation<ToolRuntime> {
  const driver = yield* createLocalToolRuntimeDriver(options)
  yield* ToolRuntimeContext.set(driver)
  return driver
}
