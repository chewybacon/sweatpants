import { createContext, type Operation, type Stream } from 'effection'
import type { ToolCall } from './types.ts'
import type { ToolInventoryEntry } from './tool-inventory.ts'

export interface ToolExecutionRef {
  runtimeId: string
  executionId: string
  callId: string
  toolName: string
  sessionId?: string
}

export interface ToolExecuteRequest {
  entry: ToolInventoryEntry
  call: ToolCall
  request?: unknown
  signal?: AbortSignal
  metadata?: Record<string, unknown>
}

export interface ToolContinuationInput {
  type: 'elicit_response' | 'client_handoff_response'
  elicitId?: string
  result: unknown
}

export interface ToolResumeRequest {
  ref: ToolExecutionRef
  input: ToolContinuationInput
  request?: unknown
  signal?: AbortSignal
  metadata?: Record<string, unknown>
}

export interface ToolExecutionError {
  code?: string
  message: string
  cause?: unknown
}

export interface ClientToolRequest {
  componentId?: string
  props?: unknown
  schema?: Record<string, unknown>
  params?: unknown
  serverOutput?: unknown
  usesHandoff?: boolean
}

export interface ElicitToolRequest {
  elicitId: string
  key: string
  message: string
  schema: Record<string, unknown>
  context?: Record<string, unknown>
}

export type ToolExecutionEvent =
  | { type: 'progress'; lsn?: number; message?: string; [key: string]: unknown }
  | { type: 'log'; lsn?: number; level?: string; message: string; [key: string]: unknown }
  | { type: 'elicit_request'; lsn?: number; elicitId: string; key: string; message: string; schema: Record<string, unknown>; [key: string]: unknown }
  | { type: 'client_request'; lsn?: number; request: ClientToolRequest; [key: string]: unknown }
  | { type: 'sample_request'; lsn?: number; sampleId: string; [key: string]: unknown }
  | { type: 'sample_response_queued'; lsn?: number; [key: string]: unknown }
  | { type: 'result'; lsn?: number; result: unknown; [key: string]: unknown }
  | { type: 'error'; lsn?: number; message: string; code?: string; [key: string]: unknown }
  | { type: 'cancelled'; lsn?: number; reason?: string; [key: string]: unknown }

export type ToolExecution =
  | { kind: 'completed'; ref: ToolExecutionRef; result: unknown }
  | { kind: 'failed'; ref: ToolExecutionRef; error: ToolExecutionError }
  | { kind: 'awaiting_client'; ref: ToolExecutionRef; request: ClientToolRequest }
  | { kind: 'awaiting_elicit'; ref: ToolExecutionRef; request: ElicitToolRequest }
  | { kind: 'running'; ref: ToolExecutionRef; events: Stream<ToolExecutionEvent, void> }

export interface ToolRuntime {
  readonly id: string
  execute(request: ToolExecuteRequest): Operation<ToolExecution>
  resume(request: ToolResumeRequest): Operation<ToolExecution>
  abort(ref: ToolExecutionRef, reason?: string): Operation<void>
}

export interface ToolExecutionContext {
  runtimeId: string
  request?: unknown
  signal?: AbortSignal
  metadata?: Record<string, unknown>
}

export interface ToolExecutionStrategy {
  readonly id: string
  canExecute(entry: ToolInventoryEntry, call: ToolCall, ctx: ToolExecutionContext): boolean | Operation<boolean>
  execute(entry: ToolInventoryEntry, call: ToolCall, ctx: ToolExecutionContext): Operation<ToolExecution>
  resume?(ref: ToolExecutionRef, input: ToolContinuationInput, ctx: ToolExecutionContext): Operation<ToolExecution>
  abort?(ref: ToolExecutionRef, reason: string | undefined, ctx: ToolExecutionContext): Operation<void>
}

export class ToolRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ToolRuntimeError'
  }
}

export interface StrategyToolRuntimeOptions {
  id?: string
  strategies: ToolExecutionStrategy[]
}

function isOperation<T>(value: boolean | Operation<T>): value is Operation<T> {
  return typeof value !== 'boolean'
}

export function createToolExecutionRef(input: {
  runtimeId: string
  callId: string
  toolName: string
  executionId?: string
  sessionId?: string
}): ToolExecutionRef {
  return {
    runtimeId: input.runtimeId,
    executionId: input.executionId ?? input.sessionId ?? input.callId,
    callId: input.callId,
    toolName: input.toolName,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  }
}

export function createStrategyToolRuntime(options: StrategyToolRuntimeOptions): ToolRuntime {
  const runtimeId = options.id ?? 'tool-runtime'
  const strategies = [...options.strategies]

  return {
    id: runtimeId,

    *execute(request: ToolExecuteRequest): Operation<ToolExecution> {
      const ctx: ToolExecutionContext = {
        runtimeId,
        ...(request.request !== undefined ? { request: request.request } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
      }

      for (const strategy of strategies) {
        const accepted = strategy.canExecute(request.entry, request.call, ctx)
        const canExecute = isOperation(accepted) ? yield* accepted : accepted
        if (canExecute) {
          return yield* strategy.execute(request.entry, request.call, ctx)
        }
      }

      throw new ToolRuntimeError('NO_MATCHING_TOOL_STRATEGY', `No tool execution strategy can execute tool: ${request.call.function.name}`)
    },

    *resume(request: ToolResumeRequest): Operation<ToolExecution> {
      for (const strategy of strategies) {
        if (!strategy.resume) continue
        try {
          return yield* strategy.resume(request.ref, request.input, {
            runtimeId,
            ...(request.request !== undefined ? { request: request.request } : {}),
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.metadata ? { metadata: request.metadata } : {}),
          })
        } catch (error) {
          if (error instanceof ToolRuntimeError && error.code === 'EXECUTION_NOT_FOUND') {
            continue
          }
          throw error
        }
      }
      throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `No strategy can resume execution: ${request.ref.executionId}`)
    },

    *abort(ref: ToolExecutionRef, reason?: string): Operation<void> {
      for (const strategy of strategies) {
        if (!strategy.abort) continue
        try {
          yield* strategy.abort(ref, reason, { runtimeId })
          return
        } catch (error) {
          if (error instanceof ToolRuntimeError && error.code === 'EXECUTION_NOT_FOUND') {
            continue
          }
          throw error
        }
      }
      throw new ToolRuntimeError('EXECUTION_NOT_FOUND', `No strategy can abort execution: ${ref.executionId}`)
    },
  }
}

export const ToolRuntimeContext = createContext<ToolRuntime>('ToolRuntime')

type LegacyRuntimeAdapter = ToolRuntime & {
  listTools?: () => Operation<ToolRuntimeToolSchema[]>
  startToolCall?: (request: StartToolCallRequest) => Operation<ToolSession>
  getSession?: (ref: ToolSessionRef) => Operation<ToolSession | null>
  respondToElicit?: (ref: ToolSessionRef, elicitId: string, response: unknown) => Operation<void>
  abortSession?: (ref: ToolSessionRef, reason?: string) => Operation<void>
}

function* activeRuntime(): Operation<ToolRuntime> {
  const runtime = yield* ToolRuntimeContext.get()
  if (!runtime) throw new ToolRuntimeError('TOOL_RUNTIME_NOT_CONFIGURED', 'Tool runtime not configured. Install a ToolRuntime in scope.')
  return runtime
}

export const ToolRuntimeApi = {
  *execute(request: ToolExecuteRequest): Operation<ToolExecution> {
    const runtime = yield* activeRuntime()
    return yield* runtime.execute(request)
  },

  *resume(request: ToolResumeRequest): Operation<ToolExecution> {
    const runtime = yield* activeRuntime()
    if (request.ref.runtimeId !== runtime.id) {
      throw new ToolRuntimeError('WRONG_TOOL_RUNTIME', `Wrong tool runtime: expected ${runtime.id}, received ${request.ref.runtimeId}`)
    }
    return yield* runtime.resume(request)
  },

  *abort(ref: ToolExecutionRef, reason?: string): Operation<void> {
    const runtime = yield* activeRuntime()
    if (ref.runtimeId !== runtime.id) {
      throw new ToolRuntimeError('WRONG_TOOL_RUNTIME', `Wrong tool runtime: expected ${runtime.id}, received ${ref.runtimeId}`)
    }
    yield* runtime.abort(ref, reason)
  },

  *listTools(): Operation<ToolRuntimeToolSchema[]> {
    const runtime = (yield* activeRuntime()) as LegacyRuntimeAdapter
    if (!runtime.listTools) throw new ToolRuntimeError('LEGACY_RUNTIME_METHOD_UNAVAILABLE', 'Active tool runtime does not implement listTools')
    return yield* runtime.listTools()
  },

  *startToolCall(request: StartToolCallRequest): Operation<ToolSession> {
    const runtime = (yield* activeRuntime()) as LegacyRuntimeAdapter
    if (!runtime.startToolCall) throw new ToolRuntimeError('LEGACY_RUNTIME_METHOD_UNAVAILABLE', 'Active tool runtime does not implement startToolCall')
    return yield* runtime.startToolCall(request)
  },

  *getSession(ref: ToolSessionRef): Operation<ToolSession | null> {
    const runtime = (yield* activeRuntime()) as LegacyRuntimeAdapter
    if (ref.runtimeId !== runtime.id) throw new ToolRuntimeError('WRONG_TOOL_RUNTIME', `Wrong tool runtime: expected ${runtime.id}, received ${ref.runtimeId}`)
    if (!runtime.getSession) throw new ToolRuntimeError('LEGACY_RUNTIME_METHOD_UNAVAILABLE', 'Active tool runtime does not implement getSession')
    return yield* runtime.getSession(ref)
  },

  *respondToElicit(ref: ToolSessionRef, elicitId: string, response: unknown): Operation<void> {
    const runtime = (yield* activeRuntime()) as LegacyRuntimeAdapter
    if (ref.runtimeId !== runtime.id) throw new ToolRuntimeError('WRONG_TOOL_RUNTIME', `Wrong tool runtime: expected ${runtime.id}, received ${ref.runtimeId}`)
    if (!runtime.respondToElicit) throw new ToolRuntimeError('LEGACY_RUNTIME_METHOD_UNAVAILABLE', 'Active tool runtime does not implement respondToElicit')
    yield* runtime.respondToElicit(ref, elicitId, response)
  },

  *abortSession(ref: ToolSessionRef, reason?: string): Operation<void> {
    const runtime = (yield* activeRuntime()) as LegacyRuntimeAdapter
    if (ref.runtimeId !== runtime.id) throw new ToolRuntimeError('WRONG_TOOL_RUNTIME', `Wrong tool runtime: expected ${runtime.id}, received ${ref.runtimeId}`)
    if (!runtime.abortSession) throw new ToolRuntimeError('LEGACY_RUNTIME_METHOD_UNAVAILABLE', 'Active tool runtime does not implement abortSession')
    yield* runtime.abortSession(ref, reason)
  },
}

// Backward-compatible structural names for in-repo packages while the runtime
// implementation migrates. These are not exposed as separate public subpaths.
export type ToolRuntimeDriver = ToolRuntime
export type ToolRuntimeToolSchema = import('./tool-inventory.ts').ToolDefinition
export interface ToolSessionRef {
  id: string
  runtimeId: string
  toolName: string
}
export type ToolSessionEvent = ToolExecutionEvent
export interface ToolSession extends ToolSessionRef {
  events(afterLSN?: number): Stream<ToolSessionEvent, void>
}
export interface StartToolCallRequest {
  toolName: string
  callId: string
  arguments: Record<string, unknown>
  signal?: AbortSignal
}
export interface ToolSessionLookupRequest extends ToolSessionRef {
  afterLSN?: number
}
