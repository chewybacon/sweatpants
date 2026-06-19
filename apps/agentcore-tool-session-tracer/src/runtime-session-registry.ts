import { SpanStatusCode, type Span } from '@opentelemetry/api'
import { each, run, sleep as effectionSleep, spawn, type Signal } from 'effection'
import { createBridgeHost, type BridgeEvent, type ElicitResponse, type SampleResponse } from '../../../packages/framework/src/lib/chat/mcp-tools/bridge-runtime.ts'
import { getRuntimeMcpTool, runtimeMcpToolNames } from './tool-registry.ts'
import type { RuntimeEvent, RuntimeRequest, RuntimeResponse, ToolStatus } from './protocol.ts'
import { log, summarizeEvent } from './observability.ts'
import { startSpan } from './telemetry.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type RawElicitResponse = { action: 'accept' | 'decline' | 'cancel'; content?: unknown }

type RawSampleResponse = {
  text: string
  model?: string | undefined
  stopReason?: string | undefined
  parsed?: unknown
  parseError?: unknown
  toolCalls?: unknown[] | undefined
}

interface PendingElicit {
  type: 'elicit'
  elicitId: string
  deferred?: Deferred<RawElicitResponse> | undefined
  bridge?: { requestId: ElicitResponse['id']; signal: Signal<ElicitResponse, void> } | undefined
}

interface PendingSample {
  type: 'sample'
  sampleId: string
  deferred?: Deferred<RawSampleResponse> | undefined
  bridge?: { signal: Signal<SampleResponse, void> } | undefined
}

type Pending = PendingElicit | PendingSample

interface RuntimeToolSession {
  runtimeSessionId: string
  toolSessionId: string
  toolName: string
  status: ToolStatus
  pending?: Pending | undefined
  nextSeq: number
  events: Array<{ seq: number; id: string; event: RuntimeEvent }>
  commandFingerprints: Map<string, string>
  startFingerprint: string
  waiters: Array<() => void>
  abortController?: AbortController | undefined
  backgroundTask?: Promise<void> | undefined
  span?: Span | undefined
  createdAt: number
  updatedAt: number
}

function fingerprint(request: RuntimeRequest): string {
  return JSON.stringify(request)
}

type PendingRequestResponse = { type: 'elicit'; elicitId: string } | { type: 'sample'; sampleId: string } | undefined

function pendingForResponse(pending: Pending | undefined): PendingRequestResponse {
  if (!pending) return undefined
  if (pending.type === 'elicit') return { type: 'elicit', elicitId: pending.elicitId }
  return { type: 'sample', sampleId: pending.sampleId }
}

function statusResponse(session: RuntimeToolSession): RuntimeResponse {
  const pendingRequest = pendingForResponse(session.pending)
  return {
    type: 'session_status',
    toolSessionId: session.toolSessionId,
    status: session.status,
    ...(pendingRequest !== undefined ? { pendingRequest } : {}),
    lastRuntimeEventSeq: session.nextSeq - 1,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripMessageContext(message: string): string {
  const boundaryIndex = message.indexOf('\n--x-elicit-context:')
  return boundaryIndex === -1 ? message : message.slice(0, boundaryIndex).trim()
}

function parseMessageContext(message: string): Record<string, unknown> | undefined {
  const marker = '\n--x-elicit-context: application/json\n'
  const markerIndex = message.indexOf(marker)
  if (markerIndex === -1) return undefined
  try {
    const parsed = JSON.parse(message.slice(markerIndex + marker.length))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function decodeBridgeElicitContext(message: string, schema: Record<string, unknown>): { message: string; context?: Record<string, unknown> | undefined } {
  const schemaContext = schema['x-elicit-context']
  const context = isRecord(schemaContext) ? schemaContext : parseMessageContext(message)
  return {
    message: stripMessageContext(message),
    ...(context !== undefined ? { context } : {}),
  }
}

function toSpanAttributes(fields: Record<string, unknown>, prefix: string): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attrs[`${prefix}.${key}`] = value
    }
  }
  return attrs
}

function errorEvent(name: string, error: unknown): RuntimeEvent {
  return {
    type: 'error',
    name,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  }
}

function toBridgeElicitResult(response: RawElicitResponse): ElicitResponse['result'] {
  if (response.action === 'accept') return { action: 'accept', content: response.content }
  return { action: response.action }
}

function toBridgeSampleResult(response: RawSampleResponse): SampleResponse['result'] {
  const result: Record<string, unknown> = { text: response.text }
  if (response.model !== undefined) result['model'] = response.model
  if (response.stopReason !== undefined) result['stopReason'] = response.stopReason
  if (response.parsed !== undefined) result['parsed'] = response.parsed
  if (response.parseError !== undefined) result['parseError'] = response.parseError
  if (response.toolCalls !== undefined) result['toolCalls'] = response.toolCalls
  return result as unknown as SampleResponse['result']
}

export interface RuntimeSessionContext {
  runtimeSessionId: string
}

function sessionKey(runtimeSessionId: string, toolSessionId: string): string {
  return JSON.stringify([runtimeSessionId, toolSessionId])
}

function isTerminalStatus(status: ToolStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'orphaned'
}

export class RuntimeSessionRegistry {
  private readonly sessions = new Map<string, RuntimeToolSession>()

  isBusy(): boolean {
    for (const session of this.sessions.values()) {
      if (!['completed', 'failed', 'cancelled', 'orphaned'].includes(session.status)) return true
    }
    return false
  }

  async handle(request: RuntimeRequest, context: RuntimeSessionContext): Promise<RuntimeResponse[]> {
    const duplicate = this.checkDuplicate(request, context)
    if (duplicate) return duplicate

    switch (request.op) {
      case 'start_tool_session':
        return await this.start(request, context)
      case 'respond_to_elicit':
        return await this.respondToElicit(request, context)
      case 'respond_to_sample':
        return await this.respondToSample(request, context)
      case 'cancel_tool_session':
        return this.cancel(request, context)
      case 'inspect_tool_session':
        return [this.inspect(request.toolSessionId, context)]
      case 'drain_tool_session_events':
        return this.drain(request.toolSessionId, request.afterRuntimeEventSeq, context)
      default:
        return [{ type: 'protocol_error', message: `unsupported op ${(request as { op?: string }).op}` }]
    }
  }

  private getSession(toolSessionId: string, context: RuntimeSessionContext): RuntimeToolSession | undefined {
    return this.sessions.get(sessionKey(context.runtimeSessionId, toolSessionId))
  }

  private checkDuplicate(request: RuntimeRequest, context: RuntimeSessionContext): RuntimeResponse[] | null {
    const session = this.getSession(request.toolSessionId, context)
    if (!session) return null
    const previous = session.commandFingerprints.get(request.commandId)
    if (!previous) return null
    if (previous === fingerprint(request)) {
      return [
        { type: 'command_duplicate', toolSessionId: request.toolSessionId, commandId: request.commandId, originalStatus: 'accepted' },
        statusResponse(session),
      ]
    }
    return [{ type: 'command_conflict', toolSessionId: request.toolSessionId, commandId: request.commandId, message: 'commandId reused with different payload' }]
  }

  private recordCommand(session: RuntimeToolSession, request: RuntimeRequest): void {
    session.commandFingerprints.set(request.commandId, fingerprint(request))
    session.updatedAt = Date.now()
  }

  private notify(session: RuntimeToolSession): void {
    const waiters = session.waiters.splice(0)
    for (const waiter of waiters) waiter()
  }

  private emit(session: RuntimeToolSession, event: RuntimeEvent): RuntimeResponse {
    const seq = session.nextSeq++
    const id = `${session.toolSessionId}:${seq}`
    session.events.push({ seq, id, event })
    session.updatedAt = Date.now()
    const eventSummary = summarizeEvent(event)
    session.span?.addEvent(`tool_event.${event.type}`, {
      'agentcore.tool_session.id': session.toolSessionId,
      'agentcore.tool.name': session.toolName,
      'agentcore.tool.status': session.status,
      'agentcore.runtime_event.seq': seq,
      'agentcore.runtime_event.id': id,
      ...toSpanAttributes(eventSummary, 'agentcore.event'),
    })
    log(event.type === 'error' ? 'error' : 'info', 'agentcore.tool_event', {
      toolSessionId: session.toolSessionId,
      toolName: session.toolName,
      status: session.status,
      runtimeEventSeq: seq,
      runtimeEventId: id,
      ...eventSummary,
    })
    this.notify(session)
    return { type: 'tool_event', toolSessionId: session.toolSessionId, runtimeEventSeq: seq, runtimeEventId: id, event }
  }

  private async waitForChange(session: RuntimeToolSession, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return
    await new Promise<void>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        const index = session.waiters.indexOf(waiter)
        if (index >= 0) session.waiters.splice(index, 1)
        resolve()
      }, timeoutMs)
      session.waiters.push(waiter)
    })
  }

  private isPauseOrTerminal(session: RuntimeToolSession): boolean {
    return session.status === 'awaiting_elicit'
      || session.status === 'awaiting_sample'
      || session.status === 'completed'
      || session.status === 'failed'
      || session.status === 'cancelled'
      || session.status === 'orphaned'
  }

  private async waitForPauseOrTerminal(session: RuntimeToolSession, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.isPauseOrTerminal(session)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      await this.waitForChange(session, Math.min(remaining, 250))
    }
  }

  private async start(request: Extract<RuntimeRequest, { op: 'start_tool_session' }>, context: RuntimeSessionContext): Promise<RuntimeResponse[]> {
    const existing = this.getSession(request.toolSessionId, context)
    if (existing) {
      if (existing.startFingerprint === fingerprint(request)) {
        return [
          { type: 'command_duplicate', toolSessionId: request.toolSessionId, commandId: request.commandId, originalStatus: 'accepted' },
          statusResponse(existing),
        ]
      }
      return [{ type: 'command_conflict', toolSessionId: request.toolSessionId, commandId: request.commandId, message: 'toolSessionId already exists with different start command' }]
    }

    const isBuiltInSmokeTool = request.toolName === 'elicit_then_result' || request.toolName === 'sample_then_result' || request.toolName === 'simple_result'
    const bridgeTool = getRuntimeMcpTool(request.toolName)
    if (!isBuiltInSmokeTool && !bridgeTool) {
      return [{
        type: 'protocol_error',
        message: `unsupported AgentCore runtime tool ${request.toolName}; supported tools: ${runtimeMcpToolNames().join(', ')}`,
      }]
    }

    const session: RuntimeToolSession = {
      runtimeSessionId: context.runtimeSessionId,
      toolSessionId: request.toolSessionId,
      toolName: request.toolName,
      status: 'running',
      nextSeq: 1,
      events: [],
      commandFingerprints: new Map(),
      startFingerprint: fingerprint(request),
      waiters: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    session.span = startSpan('agentcore.tool_session', {
      'agentcore.tool_session.id': request.toolSessionId,
      'agentcore.tool.name': request.toolName,
      'agentcore.command.id': request.commandId,
      'agentcore.call.id': request.context?.callId ?? '',
      'agentcore.conversation.id': request.context?.conversationId ?? '',
      'gen_ai.operation.name': 'tool.execute',
      'gen_ai.tool.name': request.toolName,
    })
    this.sessions.set(sessionKey(context.runtimeSessionId, request.toolSessionId), session)
    this.recordCommand(session, request)
    log('info', 'agentcore.tool_session.start', {
      toolSessionId: request.toolSessionId,
      toolName: request.toolName,
      commandId: request.commandId,
      callId: request.context?.callId,
      conversationId: request.context?.conversationId,
    })

    const immediate: RuntimeResponse[] = []
    immediate.push(this.emit(session, { type: 'progress', message: `started ${request.toolName}`, progress: 0 }))

    if (request.toolName === 'elicit_then_result') {
      const pending = deferred<{ action: 'accept' | 'decline' | 'cancel'; content?: unknown }>()
      const elicitId = `${request.toolSessionId}:elicit:1`
      session.status = 'awaiting_elicit'
      session.pending = { type: 'elicit', elicitId, deferred: pending }
      immediate.push(this.emit(session, {
        type: 'elicit_request',
        elicitId,
        key: 'confirm',
        message: 'Confirm the deterministic action?',
        schema: { type: 'object', properties: { confirmed: { type: 'boolean' } } },
      }))
      void this.runElicitTool(session, pending)
      immediate.push(statusResponse(session))
      return immediate
    }

    if (request.toolName === 'sample_then_result') {
      const pending = deferred<{ text: string; model?: string | undefined; stopReason?: string | undefined; parsed?: unknown; parseError?: unknown; toolCalls?: unknown[] | undefined }>()
      const sampleId = `${request.toolSessionId}:sample:1`
      session.status = 'awaiting_sample'
      session.pending = { type: 'sample', sampleId, deferred: pending }
      immediate.push(this.emit(session, {
        type: 'sample_request',
        sampleId,
        messages: [{ role: 'user', content: 'Say deterministic hello' }],
      }))
      void this.runSampleTool(session, pending)
      immediate.push(statusResponse(session))
      return immediate
    }

    if (bridgeTool) {
      return await this.startBridgeTool(session, request, bridgeTool)
    }

    if (request.toolName === 'simple_result') {
      session.status = 'completed'
      immediate.push(this.emit(session, { type: 'result', result: { ok: true, params: request.params ?? null } }))
      immediate.push(statusResponse(session))
      return immediate
    }

    session.status = 'failed'
    immediate.push(this.emit(session, { type: 'error', name: 'UnknownTool', message: `unknown tool ${request.toolName}` }))
    immediate.push(statusResponse(session))
    return immediate
  }

  private handleBridgeEvent(session: RuntimeToolSession, event: BridgeEvent): void {
    if (isTerminalStatus(session.status)) return

    switch (event.type) {
      case 'notify':
        this.emit(session, {
          type: 'progress',
          message: event.message,
          ...(event.progress !== undefined ? { progress: event.progress } : {}),
        })
        return

      case 'log':
        this.emit(session, {
          type: 'log',
          level: event.level,
          message: event.message,
        })
        return

      case 'elicit': {
        const elicitId = `${session.toolSessionId}:elicit:${event.request.key}:${event.request.seq}`
        const schema = event.request.schema.json as Record<string, unknown>
        const decoded = decodeBridgeElicitContext(event.request.message, schema)
        session.status = 'awaiting_elicit'
        session.pending = {
          type: 'elicit',
          elicitId,
          bridge: { requestId: event.request.id, signal: event.responseSignal },
        }
        this.emit(session, {
          type: 'elicit_request',
          elicitId,
          key: event.request.key,
          message: decoded.message,
          schema,
          ...(decoded.context !== undefined ? { context: decoded.context } : {}),
        })
        return
      }

      case 'sample': {
        const sampleId = `${session.toolSessionId}:sample:${session.nextSeq}`
        session.status = 'awaiting_sample'
        session.pending = {
          type: 'sample',
          sampleId,
          bridge: { signal: event.responseSignal },
        }
        this.emit(session, {
          type: 'sample_request',
          sampleId,
          messages: event.messages,
          ...(event.options?.systemPrompt !== undefined ? { systemPrompt: event.options.systemPrompt } : {}),
          ...(event.options?.maxTokens !== undefined ? { maxTokens: event.options.maxTokens } : {}),
          ...(event.options?.tools !== undefined ? { tools: event.options.tools } : {}),
          ...(event.options?.toolChoice !== undefined ? { toolChoice: event.options.toolChoice } : {}),
          ...(event.options?.schema !== undefined ? { schema: event.options.schema } : {}),
        })
      }
    }
  }

  private async startBridgeTool(
    session: RuntimeToolSession,
    request: Extract<RuntimeRequest, { op: 'start_tool_session' }>,
    tool: NonNullable<ReturnType<typeof getRuntimeMcpTool>>
  ): Promise<RuntimeResponse[]> {
    const self = this
    const abortController = new AbortController()
    session.abortController = abortController
    session.backgroundTask = run(function* () {
      try {
        const host = createBridgeHost({
          tool,
          params: request.params,
          callId: request.context?.callId ?? request.toolSessionId,
          signal: abortController.signal,
          ...(request.context?.parentMessages !== undefined ? { parentMessages: request.context.parentMessages as never } : {}),
          ...(request.context?.systemPrompt !== undefined ? { systemPrompt: request.context.systemPrompt } : {}),
        })

        yield* spawn(function* () {
          for (const bridgeEvent of yield* each(host.events)) {
            self.handleBridgeEvent(session, bridgeEvent)
            yield* each.next()
          }
        })
        yield* effectionSleep(0)

        const result = yield* host.run()
        if (isTerminalStatus(session.status)) return
        session.pending = undefined
        session.status = 'completed'
        const duration = Date.now() - session.createdAt
        session.span?.setAttributes({
          'agentcore.tool.status': 'completed',
          'agentcore.tool.duration_ms': duration,
          'agentcore.runtime_event.count': session.events.length,
        })
        session.span?.setStatus({ code: SpanStatusCode.OK })
        session.span?.end()
        session.span = undefined
        log('info', 'agentcore.tool_session.completed', {
          toolSessionId: session.toolSessionId,
          toolName: session.toolName,
          durationMs: duration,
          runtimeEventCount: session.events.length,
        })
        self.emit(session, { type: 'result', result })
      } catch (error) {
        if (isTerminalStatus(session.status)) return
        session.pending = undefined
        session.status = 'failed'
        const duration = Date.now() - session.createdAt
        session.span?.recordException(error as Error)
        session.span?.setAttributes({
          'agentcore.tool.status': 'failed',
          'agentcore.tool.duration_ms': duration,
          'agentcore.runtime_event.count': session.events.length,
        })
        session.span?.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) })
        session.span?.end()
        session.span = undefined
        log('error', 'agentcore.tool_session.failed', {
          toolSessionId: session.toolSessionId,
          toolName: session.toolName,
          durationMs: duration,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        self.emit(session, errorEvent('BridgeToolError', error))
      }
    }).then(
      () => undefined,
      (error: unknown) => {
        if (isTerminalStatus(session.status)) return
        session.pending = undefined
        session.status = 'failed'
        const duration = Date.now() - session.createdAt
        session.span?.recordException(error as Error)
        session.span?.setAttributes({
          'agentcore.tool.status': 'failed',
          'agentcore.tool.duration_ms': duration,
          'agentcore.runtime_event.count': session.events.length,
        })
        session.span?.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) })
        session.span?.end()
        session.span = undefined
        log('error', 'agentcore.tool_session.task_failed', {
          toolSessionId: session.toolSessionId,
          toolName: session.toolName,
          durationMs: duration,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        self.emit(session, errorEvent('BridgeToolTaskError', error))
      }
    )

    await this.waitForPauseOrTerminal(session)
    return this.drain(session.toolSessionId, 0, { runtimeSessionId: session.runtimeSessionId })
  }

  private async runElicitTool(session: RuntimeToolSession, pending: Deferred<RawElicitResponse>): Promise<void> {
    try {
      const response = await pending.promise
      if (isTerminalStatus(session.status)) return
      session.pending = undefined
      session.status = 'running'
      const content = response.action === 'accept' ? response.content : { action: response.action }
      this.emit(session, { type: 'progress', message: 'resumed after elicit', progress: 0.75 })
      if (isTerminalStatus(session.status)) return
      session.status = 'completed'
      this.emit(session, { type: 'result', result: { elicitResponse: content } })
    } catch (error) {
      if (isTerminalStatus(session.status)) return
      session.status = 'failed'
      this.emit(session, { type: 'error', name: 'ToolError', message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async runSampleTool(session: RuntimeToolSession, pending: Deferred<{ text: string; model?: string | undefined; stopReason?: string | undefined; parsed?: unknown; parseError?: unknown; toolCalls?: unknown[] | undefined }>): Promise<void> {
    try {
      const response = await pending.promise
      if (isTerminalStatus(session.status)) return
      session.pending = undefined
      session.status = 'running'
      this.emit(session, { type: 'progress', message: 'resumed after sample', progress: 0.75 })
      if (isTerminalStatus(session.status)) return
      session.status = 'completed'
      this.emit(session, { type: 'result', result: { sampleText: response.text, model: response.model ?? null } })
    } catch (error) {
      if (isTerminalStatus(session.status)) return
      session.status = 'failed'
      this.emit(session, { type: 'error', name: 'ToolError', message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async respondToElicit(request: Extract<RuntimeRequest, { op: 'respond_to_elicit' }>, context: RuntimeSessionContext): Promise<RuntimeResponse[]> {
    const session = this.getSession(request.toolSessionId, context)
    if (!session) return [{ type: 'session_not_found', toolSessionId: request.toolSessionId }]
    if (isTerminalStatus(session.status)) return [statusResponse(session)]
    const pending = session.pending
    if (!pending || pending.type !== 'elicit' || pending.elicitId !== request.elicitId) {
      return [{ type: 'command_conflict', toolSessionId: request.toolSessionId, commandId: request.commandId, message: 'not awaiting matching elicit' }]
    }
    this.recordCommand(session, request)
    session.pending = undefined
    session.status = 'running'
    pending.deferred?.resolve(request.response)
    pending.bridge?.signal.send({ id: pending.bridge.requestId, result: toBridgeElicitResult(request.response) })
    await this.waitForPauseOrTerminal(session)
    return this.drain(request.toolSessionId, 0, context)
  }

  private async respondToSample(request: Extract<RuntimeRequest, { op: 'respond_to_sample' }>, context: RuntimeSessionContext): Promise<RuntimeResponse[]> {
    const session = this.getSession(request.toolSessionId, context)
    if (!session) return [{ type: 'session_not_found', toolSessionId: request.toolSessionId }]
    if (isTerminalStatus(session.status)) return [statusResponse(session)]
    const pending = session.pending
    if (!pending || pending.type !== 'sample' || pending.sampleId !== request.sampleId) {
      return [{ type: 'command_conflict', toolSessionId: request.toolSessionId, commandId: request.commandId, message: 'not awaiting matching sample' }]
    }
    this.recordCommand(session, request)
    session.pending = undefined
    session.status = 'running'
    pending.deferred?.resolve(request.response)
    pending.bridge?.signal.send({ result: toBridgeSampleResult(request.response) })
    await this.waitForPauseOrTerminal(session)
    return this.drain(request.toolSessionId, 0, context)
  }

  private cancel(request: Extract<RuntimeRequest, { op: 'cancel_tool_session' }>, context: RuntimeSessionContext): RuntimeResponse[] {
    const session = this.getSession(request.toolSessionId, context)
    if (!session) return [{ type: 'session_not_found', toolSessionId: request.toolSessionId }]
    if (isTerminalStatus(session.status)) return [statusResponse(session)]
    this.recordCommand(session, request)
    session.pending = undefined
    session.abortController?.abort(request.reason)
    session.status = 'cancelled'
    session.span?.setAttributes({
      'agentcore.tool.status': 'cancelled',
      'agentcore.tool.duration_ms': Date.now() - session.createdAt,
      'agentcore.runtime_event.count': session.events.length,
    })
    session.span?.setStatus({ code: SpanStatusCode.ERROR, message: request.reason ?? 'cancelled' })
    session.span?.end()
    session.span = undefined
    return [this.emit(session, { type: 'cancelled', ...(request.reason !== undefined && { reason: request.reason }) }), statusResponse(session)]
  }

  private inspect(toolSessionId: string, context: RuntimeSessionContext): RuntimeResponse {
    const session = this.getSession(toolSessionId, context)
    if (!session) return { type: 'session_not_found', toolSessionId }
    return statusResponse(session)
  }

  private drain(toolSessionId: string, afterRuntimeEventSeq: number, context: RuntimeSessionContext): RuntimeResponse[] {
    const session = this.getSession(toolSessionId, context)
    if (!session) return [{ type: 'session_not_found', toolSessionId }]
    return [
      ...session.events
        .filter((event) => event.seq > afterRuntimeEventSeq)
        .map((event): RuntimeResponse => ({
          type: 'tool_event',
          toolSessionId,
          runtimeEventSeq: event.seq,
          runtimeEventId: event.id,
          event: event.event,
        })),
      statusResponse(session),
    ]
  }
}

export const registry = new RuntimeSessionRegistry()
