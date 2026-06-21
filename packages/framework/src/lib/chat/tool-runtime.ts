import { createContext, type Operation, type Stream } from 'effection'

export interface ToolRuntimeToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolSessionRef {
  id: string
  runtimeId: string
  toolName: string
}

export type ToolSessionEvent =
  | { type: 'progress'; lsn: number; message?: string; [key: string]: unknown }
  | { type: 'log'; lsn: number; level?: string; message: string; [key: string]: unknown }
  | { type: 'elicit_request'; lsn: number; elicitId: string; [key: string]: unknown }
  | { type: 'result'; lsn: number; result: unknown; [key: string]: unknown }
  | { type: 'error'; lsn: number; message: string; [key: string]: unknown }
  | { type: 'cancelled'; lsn: number; reason?: string; [key: string]: unknown }

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

export interface ToolRuntimeDriver {
  readonly id: string
  listTools(): Operation<ToolRuntimeToolSchema[]>
  startToolCall(request: StartToolCallRequest): Operation<ToolSession>
  getSession(ref: ToolSessionRef): Operation<ToolSession | null>
  respondToElicit(ref: ToolSessionRef, elicitId: string, response: unknown): Operation<void>
  abortSession(ref: ToolSessionRef, reason?: string): Operation<void>
}

export const ToolRuntimeContext = createContext<ToolRuntimeDriver>('ToolRuntimeDriver')

export const ToolRuntimeApi = {
  *listTools(): Operation<ToolRuntimeToolSchema[]> {
    const driver = yield* ToolRuntimeContext.get()
    if (!driver) throw new Error('Tool runtime not configured. Install a ToolRuntimeDriver in scope.')
    return yield* driver.listTools()
  },
  *startToolCall(request: StartToolCallRequest): Operation<ToolSession> {
    const driver = yield* ToolRuntimeContext.get()
    if (!driver) throw new Error('Tool runtime not configured. Install a ToolRuntimeDriver in scope.')
    return yield* driver.startToolCall(request)
  },
  *getSession(ref: ToolSessionRef): Operation<ToolSession | null> {
    const driver = yield* ToolRuntimeContext.get()
    if (!driver) throw new Error('Tool runtime not configured. Install a ToolRuntimeDriver in scope.')
    if (ref.runtimeId !== driver.id) throw new Error(`Wrong tool runtime: expected ${driver.id}, received ${ref.runtimeId}`)
    return yield* driver.getSession(ref)
  },
  *respondToElicit(ref: ToolSessionRef, elicitId: string, response: unknown): Operation<void> {
    const driver = yield* ToolRuntimeContext.get()
    if (!driver) throw new Error('Tool runtime not configured. Install a ToolRuntimeDriver in scope.')
    if (ref.runtimeId !== driver.id) throw new Error(`Wrong tool runtime: expected ${driver.id}, received ${ref.runtimeId}`)
    yield* driver.respondToElicit(ref, elicitId, response)
  },
  *abortSession(ref: ToolSessionRef, reason?: string): Operation<void> {
    const driver = yield* ToolRuntimeContext.get()
    if (!driver) throw new Error('Tool runtime not configured. Install a ToolRuntimeDriver in scope.')
    if (ref.runtimeId !== driver.id) throw new Error(`Wrong tool runtime: expected ${driver.id}, received ${ref.runtimeId}`)
    yield* driver.abortSession(ref, reason)
  },
}
