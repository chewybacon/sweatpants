/**
 * AgentCtx — composition, history, interrupt, sample, and progress vocabulary.
 *
 * This file implements the unified tool model semantics: tool calls return
 * `{ result, exchange }`, tools receive a leaf `ToolCtx` with local history,
 * elicitation/sample interrupts carry AG-UI-style descriptors, and server-side
 * samples resolve without parking.
 */

import { withResolvers } from 'effection'
import type { Operation } from 'effection'

import type {
  AgentFactory,
  AgentInput,
  AgentOutput,
  ModelSelection,
  TargetInput,
  TargetOutput,
  ToolTarget,
} from './types.ts'
import type {
  AgentCallExchange,
  AgentCallResult,
  AgentEvent,
  AgentMessage,
  AgentState,
  DistributiveOmit,
  DynamicElicitOptions,
  ElicitExchange,
  ElicitRequest,
  ElicitResult,
  IncomingElicitResponse,
  InterruptDescriptor,
  InterruptReason,
  LogLevel,
  Message,
  RawElicitResult,
  SampleExchange,
  SampleOptions,
  SampleResult,
  ToolCallExchange,
  ToolCallResult,
} from './events.ts'
import {
  createMessage,
  messageText,
  nextMessageId,
  normalizeContent,
} from './events.ts'
import type { AgentStream } from './stream.ts'
import type {
  NormalizedElicitsMap,
  ToolCtx,
  UnifiedToolFactory,
} from './tool-ctx.ts'

// ============================================================================
// Sample provider (the agent's model — fulfils ctx.sample locally)
// ============================================================================

export interface SampleRequest {
  model: ModelSelection
  messages: AgentMessage[]
  options?: SampleOptions<any>
  systemPrompt: string
}

export interface SampleProvider {
  sample(request: SampleRequest): Operation<Partial<SampleResult> & { content: string; raw?: unknown }>
}

// ============================================================================
// Request router — parking + requestId-correlated delivery (REQ-016/018)
// ============================================================================

export type ResolveResult =
  | { ok: true; duplicate?: boolean }
  | { ok: false; code: string; message: string }

interface PendingElicit {
  type: 'elicit'
  interrupt: InterruptDescriptor
  responseSchema?: unknown
  resolvers: ReturnType<typeof withResolvers<RawElicitResult>>
}

interface PendingSample {
  type: 'sample'
  interrupt: InterruptDescriptor
  sample: SampleOptions<any>
  resolvers: ReturnType<typeof withResolvers<Partial<SampleResult> & { content: string; raw?: unknown }>>
}

type PendingMailbox = PendingElicit | PendingSample

interface CompletedResponse {
  type: 'elicit' | 'sample'
  fingerprint: string
}

export interface RequestRouter {
  registerElicit(interrupt: InterruptDescriptor, responseSchema?: unknown): void
  registerSample(interrupt: InterruptDescriptor, sample: SampleOptions<any>): void
  awaitElicit(requestId: string): Operation<RawElicitResult>
  awaitSample(requestId: string): Operation<Partial<SampleResult> & { content: string; raw?: unknown }>
  resolveElicit(requestId: string, result: IncomingElicitResponse): ResolveResult
  resolveSample(requestId: string, result: Partial<SampleResult> & { content?: string; raw?: unknown }): ResolveResult
  forget(requestId: string): void
  pendingInterruptIds(): string[]
  pendingCount(): number
  abort(reason?: string): void
  isAborted(): boolean
}

export function createRequestRouter(): RequestRouter {
  const pending = new Map<string, PendingMailbox>()
  const completed = new Map<string, CompletedResponse>()
  let aborted = false
  let abortReason: string | undefined

  function ensureNotCompleted(id: string, type: 'elicit' | 'sample'): ResolveResult | undefined {
    const prior = completed.get(id)
    if (!prior) return undefined
    if (prior.type !== type) {
      return { ok: false, code: 'conflicting_resume', message: `Interrupt "${id}" was already resolved as ${prior.type}` }
    }
    return undefined
  }

  function checkExpiry(interrupt: InterruptDescriptor): ResolveResult | undefined {
    if (!interrupt.expiresAt) return undefined
    const expires = Date.parse(interrupt.expiresAt)
    if (!Number.isFinite(expires)) {
      return { ok: false, code: 'invalid_interrupt_expiry', message: `Interrupt "${interrupt.id}" has malformed expiresAt` }
    }
    if (Date.now() > expires) {
      pending.delete(interrupt.id)
      return { ok: false, code: 'interrupt_expired', message: `Interrupt "${interrupt.id}" has expired` }
    }
    return undefined
  }

  return {
    registerElicit(interrupt, responseSchema) {
      if (aborted) throw codedError('run_aborted', abortReason ?? 'Run aborted')
      if (pending.has(interrupt.id)) return
      pending.set(interrupt.id, {
        type: 'elicit',
        interrupt,
        responseSchema,
        resolvers: withResolvers<RawElicitResult>(),
      })
    },
    registerSample(interrupt, sample) {
      if (aborted) throw codedError('run_aborted', abortReason ?? 'Run aborted')
      if (pending.has(interrupt.id)) return
      pending.set(interrupt.id, {
        type: 'sample',
        interrupt,
        sample,
        resolvers: withResolvers<Partial<SampleResult> & { content: string; raw?: unknown }>(),
      })
    },
    *awaitElicit(requestId) {
      const mb = pending.get(requestId)
      if (!mb || mb.type !== 'elicit') throw codedError('unknown_interrupt_id', `Unknown elicit id "${requestId}"`)
      return yield* mb.resolvers.operation
    },
    *awaitSample(requestId) {
      const mb = pending.get(requestId)
      if (!mb || mb.type !== 'sample') throw codedError('unknown_interrupt_id', `Unknown sample id "${requestId}"`)
      return yield* mb.resolvers.operation
    },
    resolveElicit(requestId, incoming) {
      if (aborted) return { ok: false, code: 'run_aborted', message: abortReason ?? 'Run aborted' }
      const duplicate = completed.get(requestId)
      const normalized = normalizeIncomingElicit(incoming)
      const fingerprint = stableStringify(normalized)
      if (duplicate) {
        if (duplicate.type === 'elicit' && duplicate.fingerprint === fingerprint) return { ok: true, duplicate: true }
        return { ok: false, code: 'conflicting_resume', message: `Conflicting resume for "${requestId}"` }
      }
      const completedErr = ensureNotCompleted(requestId, 'elicit')
      if (completedErr) return completedErr
      const mb = pending.get(requestId)
      if (!mb || mb.type !== 'elicit') {
        return { ok: false, code: 'unknown_interrupt_id', message: `Unknown elicit id "${requestId}"` }
      }
      const expiryErr = checkExpiry(mb.interrupt)
      if (expiryErr) return expiryErr
      if (normalized.action === 'accept') {
        const validation = validateWithSchema(mb.responseSchema, normalized.content)
        if (!validation.ok) return { ok: false, code: 'invalid_resume_payload', message: validation.message }
        normalized.content = validation.value
      }
      completed.set(requestId, { type: 'elicit', fingerprint: stableStringify(normalized) })
      pending.delete(requestId)
      mb.resolvers.resolve(normalized)
      return { ok: true }
    },
    resolveSample(requestId, incoming) {
      if (aborted) return { ok: false, code: 'run_aborted', message: abortReason ?? 'Run aborted' }
      const content = incoming.content
      if (typeof content !== 'string') {
        return { ok: false, code: 'invalid_sample_response', message: `Sample response for "${requestId}" must include string content` }
      }
      const normalized = { ...incoming, content }
      const fingerprint = stableStringify(normalized)
      const duplicate = completed.get(requestId)
      if (duplicate) {
        if (duplicate.type === 'sample' && duplicate.fingerprint === fingerprint) return { ok: true, duplicate: true }
        return { ok: false, code: 'conflicting_resume', message: `Conflicting resume for "${requestId}"` }
      }
      const mb = pending.get(requestId)
      if (!mb || mb.type !== 'sample') {
        return { ok: false, code: 'unknown_interrupt_id', message: `Unknown sample id "${requestId}"` }
      }
      const expiryErr = checkExpiry(mb.interrupt)
      if (expiryErr) return expiryErr
      completed.set(requestId, { type: 'sample', fingerprint })
      pending.delete(requestId)
      mb.resolvers.resolve(normalized)
      return { ok: true }
    },
    forget(requestId) {
      pending.delete(requestId)
    },
    pendingInterruptIds() {
      return [...pending.keys()]
    },
    pendingCount() {
      return pending.size
    },
    abort(reason) {
      aborted = true
      abortReason = reason
      for (const [id, mb] of pending) {
        completed.set(id, { type: mb.type, fingerprint: '__aborted__' })
      }
      pending.clear()
    },
    isAborted() {
      return aborted
    },
  }
}

// ============================================================================
// AgentCtx interface
// ============================================================================

export interface AgentCtx<
  TTools extends Record<string, ToolTarget> = Record<string, ToolTarget>,
  TSub extends
    | Record<string, AgentFactory<any, any, any, any>>
    | undefined = Record<string, AgentFactory<any, any, any, any>>,
> {
  /** Composition primitive. Tool targets return ToolCallResult; agents return AgentCallResult. */
  call<TTarget extends CompositionTarget>(target: TTarget, input: InputFor<TTarget>): Operation<CallResultFor<TTarget>>
  /** Migration helper returning only the typed result (REQ-028). */
  callResult<TTarget extends CompositionTarget>(target: TTarget, input: InputFor<TTarget>): Operation<ResultOnlyFor<TTarget>>
  agents: AgentSugarMap<TSub>
  tools: ToolSugarMap<TTools>
  sample<TParsed = undefined>(options: SampleOptions<TParsed>): Operation<SampleResult<TParsed>>
  elicit(key: string, request: ElicitRequest): Operation<ElicitResult>
  elicitDynamic(options: DynamicElicitOptions): Operation<ElicitResult<unknown, unknown>>
  notify(message: string, fraction?: number, level?: LogLevel): Operation<void>
  log(level: LogLevel, message: string): Operation<void>
  state: AgentState
  /** Agent conversation history (mutable explicit append). */
  history: AgentMessage[]
  /** Parent-spec alias for history. */
  messages: AgentMessage[]
}

export type CompositionTarget =
  | string
  | ToolTarget
  | AgentFactory<any, any, any, any>
  | RemoteHandle

type InputFor<T> = T extends AgentFactory<any, any, any, any>
  ? AgentInput<T>
  : T extends ToolTarget
    ? TargetInput<T>
    : unknown

type CallResultFor<T> = T extends AgentFactory<any, any, any, any>
  ? AgentCallResult<AgentOutput<T>>
  : T extends ToolTarget
    ? ToolCallResult<TargetOutput<T>>
    : unknown

type ResultOnlyFor<T> = T extends AgentFactory<any, any, any, any>
  ? AgentOutput<T>
  : T extends ToolTarget
    ? TargetOutput<T>
    : unknown

export interface RemoteHandle {
  readonly __remoteHandle: true
  readonly kind: 'a2a' | 'agentcore'
  readonly name: string
  readonly target: unknown
}

export function isRemoteHandle(value: unknown): value is RemoteHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as RemoteHandle).__remoteHandle === true
  )
}

export function isAgentFactory(value: unknown): value is AgentFactory {
  return (
    typeof value === 'function' &&
    typeof (value as AgentFactory).entry === 'function' &&
    typeof (value as AgentFactory).name === 'string'
  )
}

type AgentSugarMap<M> = M extends Record<string, unknown>
  ? {
      [K in keyof M]: M[K] extends AgentFactory<any, any, any, any>
        ? (input: AgentInput<M[K]>) => Operation<AgentCallResult<AgentOutput<M[K]>>>
        : never
    }
  : Record<string, never>

type ToolSugarMap<M> = M extends Record<string, unknown>
  ? {
      [K in keyof M]: (input: TargetInput<M[K]>) => Operation<ToolCallResult<TargetOutput<M[K]>>>
    }
  : Record<string, never>

// ============================================================================
// AgentInstance (activation result)
// ============================================================================

export interface AgentInstance<I = unknown, O = unknown> {
  readonly factory: AgentFactory<I, O, any, any>
  invoke(input: I): Operation<O>
}

// ============================================================================
// Builder
// ============================================================================

export interface BuildCtxOptions {
  agent: AgentFactory
  stream: AgentStream
  subSessionId: string | undefined
  router: RequestRouter
  sampleProvider: SampleProvider | undefined
  messages: AgentMessage[]
  state: AgentState
  invokeSubAgent: (
    factory: AgentFactory,
    input: unknown,
    subSessionId: string,
  ) => Operation<unknown>
}

export function buildAgentCtx(opts: BuildCtxOptions): AgentCtx {
  const { agent, stream, subSessionId, router, sampleProvider, messages, state } = opts
  let agentInterruptSeq = 0

  function* emit(event: DistributiveOmit<AgentEvent, 'lsn' | 'timestamp'>): Operation<void> {
    const withSub =
      subSessionId && !('subSessionId' in event)
        ? { ...event, subSessionId }
        : { ...event }
    yield* stream.append({ ...(withSub as object) } as AgentEvent)
  }

  function* checkpoint(): Operation<void> {
    yield* emitCheckpoint(stream, messages, state, router.pendingInterruptIds())
  }

  function* call(target: CompositionTarget, input: unknown): Operation<unknown> {
    if (typeof target === 'string') {
      const toolFactory = (agent.tools as Record<string, unknown>)[target]
      if (!toolFactory) throw new UnresolvableTargetError(target, agent)
      return yield* callTool(target, toolFactory, input)
    }

    if (isAgentFactory(target)) {
      return yield* callAgent(target, input)
    }

    if (isUnifiedToolFactory(target) || isCoreToolFactory(target)) {
      const name = typeof (target as { name?: unknown }).name === 'string' ? (target as { name: string }).name : 'tool'
      return yield* callTool(name, target, input)
    }

    if (isRemoteHandle(target)) {
      throw new Error(
        `Remote handle "${target.name}" (kind=${target.kind}) is not yet supported. A2A/agentcore transports are implemented in stage 2.`,
      )
    }

    throw new UnresolvableTargetError(target, agent)
  }

  function* callResult(target: CompositionTarget, input: unknown): Operation<unknown> {
    const wrapped = (yield* call(target, input)) as { result?: unknown }
    return wrapped && typeof wrapped === 'object' && 'result' in wrapped ? wrapped.result : wrapped
  }

  function* callTool(name: string, toolFactory: unknown, input: unknown): Operation<ToolCallResult> {
    const callId = `${name}-${generateId()}`
    const localHistory: Message[] = []
    const elicits = extractNormalizedElicits(toolFactory)
    const request = createToolUseMessage(name, callId, input)
    yield* emit({ type: 'tool_call_start', subSessionId: callId, toolName: name, name, callId, input })
    try {
      const toolCtx = createToolCtx({
        baseCtx: ctx,
        toolName: name,
        toolCallId: callId,
        localHistory,
        elicits,
      })
      const result = yield* invokeTool(toolFactory, input, toolCtx)
      const response = createToolResultMessage(callId, result)
      const exchange: ToolCallExchange = {
        request,
        response,
        messages: [request, ...localHistory, response],
      }
      yield* emit({ type: 'tool_call_result', subSessionId: callId, callId, result, exchange })
      // Migration alias for parent-spec consumers.
      yield* emit({ type: 'tool_call_end', subSessionId: callId, callId, result, exchange })
      return { result, exchange }
    } catch (err) {
      const response = createToolResultMessage(callId, messageOf(err), true)
      const exchange: ToolCallExchange = {
        request,
        response,
        messages: [request, ...localHistory, response],
      }
      yield* emit({ type: 'tool_call_result', subSessionId: callId, callId, error: messageOf(err), exchange })
      yield* emit({ type: 'tool_call_end', subSessionId: callId, callId, error: messageOf(err), exchange })
      throw err
    }
  }

  function* callAgent(target: AgentFactory, input: unknown): Operation<AgentCallResult> {
    const childSubSessionId = `${target.name}-${generateId()}`
    const request = createMessage('user', toTextContent(input), nextMessageId('agent-call-req')) as Message & { role: 'user' }
    yield* emit({ type: 'sub_session_start', subSessionId: childSubSessionId, target: target.name, input })
    try {
      const result = yield* opts.invokeSubAgent(target, input, childSubSessionId)
      const response = createMessage('assistant', toTextContent(result), nextMessageId('agent-call-res')) as Message & { role: 'assistant' }
      const exchange: AgentCallExchange = { request, response, messages: [request, response] }
      yield* emit({ type: 'sub_session_end', subSessionId: childSubSessionId, result, exchange })
      return { result, exchange }
    } catch (err) {
      yield* emit({ type: 'sub_session_end', subSessionId: childSubSessionId, error: messageOf(err) })
      throw err
    }
  }

  function createToolCtx(args: {
    baseCtx: AgentCtx
    toolName: string
    toolCallId: string
    localHistory: Message[]
    elicits: NormalizedElicitsMap
  }): ToolCtx {
    let seq = 0

    function* elicit(key: string, options: Record<string, unknown> & { message: string }): Operation<ElicitResult> {
      const declared = args.elicits[key]
      if (!declared) {
        // Legacy compatibility: unkeyed framework tools pass an ad-hoc schema.
        if (Object.keys(args.elicits).length === 0 && (options['schema'] || options['responseSchema'])) {
          return yield* elicitDynamic({
            key,
            message: options.message,
            responseSchema: options['responseSchema'] ?? options['schema'],
            context: extractContext(options),
          })
        }
        throw codedError('unknown_elicit_key', `Unknown elicit key "${key}" for tool "${args.toolName}"`)
      }
      const interruptOptions = (options['interrupt'] ?? {}) as Record<string, unknown>
      const context = extractContext(options)
      const parsedContext = validateContext(declared.context, context)
      const interrupt = buildInterrupt({
        key,
        seq: seq++,
        message: options.message,
        responseSchema: declared.response,
        contextSchema: declared.context,
        context: parsedContext,
        toolCallId: args.toolCallId,
        reason: (interruptOptions['reason'] as InterruptReason | undefined) ?? declared.reason,
        ttlMs: (interruptOptions['ttlMs'] as number | undefined) ?? declared.ttlMs,
        expiresAt: interruptOptions['expiresAt'] as string | undefined,
        metadata: {
          ...(declared.metadata ?? {}),
          ...((interruptOptions['metadata'] as Record<string, unknown> | undefined) ?? {}),
        },
      })
      return yield* runElicit(interrupt, declared.response, parsedContext)
    }

    function* elicitDynamic(options: DynamicElicitOptions): Operation<ElicitResult<unknown, unknown>> {
      const interrupt = buildInterrupt({
        key: options.key,
        seq: seq++,
        message: options.message,
        responseSchema: options.responseSchema,
        contextSchema: options.contextSchema,
        context: options.context,
        toolCallId: args.toolCallId,
        reason: options.reason,
        ttlMs: options.ttlMs,
        expiresAt: options.expiresAt,
        metadata: options.metadata,
      })
      return yield* runElicit(interrupt, options.responseSchema, options.context)
    }

    return {
      history: args.localHistory,
      elicit: elicit as ToolCtx['elicit'],
      elicitDynamic,
      sample: sample as ToolCtx['sample'],
      notify,
      log,
    }
  }

  function* runElicit<TContext>(
    interrupt: InterruptDescriptor,
    responseSchema: unknown,
    context: TContext,
  ): Operation<ElicitResult<TContext, unknown>> {
    router.registerElicit(interrupt, responseSchema)
    yield* checkpoint()
    yield* emit({
      type: 'elicit_request',
      interrupt,
      requestId: interrupt.id,
      key: interrupt.key,
      message: interrupt.message,
      schema: responseSchema,
    })
    const raw = yield* router.awaitElicit(interrupt.id)
    if (raw.action !== 'accept') {
      if (raw.action === 'decline') {
        return raw.reason === undefined
          ? { action: 'decline', status: 'declined' }
          : { action: 'decline', status: 'declined', reason: raw.reason }
      }
      return raw.reason === undefined
        ? { action: 'cancel', status: 'cancelled' }
        : { action: 'cancel', status: 'cancelled', reason: raw.reason }
    }
    const exchange = createElicitExchange(interrupt, context, raw.content)
    return {
      action: 'accept',
      content: raw.content,
      exchange,
      status: 'accepted',
      value: raw.content,
    }
  }

  function* sample<TParsed = undefined>(options: SampleOptions<TParsed>): Operation<SampleResult<TParsed>> {
    if (!sampleProvider) {
      const interrupt = buildInterrupt({
        key: '__sample__',
        seq: agentInterruptSeq++,
        message: options.prompt ?? 'Sample request',
        reason: 'input_required',
      })
      router.registerSample(interrupt, options)
      yield* checkpoint()
      yield* emit({
        type: 'sample_request',
        interrupt,
        sample: options,
        requestId: interrupt.id,
        messages: [...messages],
        options,
      })
      const raw = yield* router.awaitSample(interrupt.id)
      return normalizeSampleResult(options, raw) as SampleResult<TParsed>
    }

    const raw = yield* sampleProvider.sample({
      model: agent.model,
      messages: [...messages],
      options,
      systemPrompt: effectiveSystemPrompt(agent),
    })
    const result = normalizeSampleResult(options, raw) as SampleResult<TParsed>
    if (result.content) {
      yield* emit({ type: 'progress', message: result.content, level: 'info' })
      // Migration alias for earlier tests/consumers.
      yield* emit({ type: 'text_delta', messageId: result.exchange.response.id, delta: result.content })
    }
    return result
  }

  function* elicit(key: string, request: ElicitRequest): Operation<ElicitResult> {
    const context = request.context ?? extractContext(request as Record<string, unknown> & { message: string })
    const responseSchema = request.responseSchema ?? request.schema
    const interrupt = buildInterrupt({
      key,
      seq: agentInterruptSeq++,
      message: request.message,
      responseSchema,
      contextSchema: request.contextSchema,
      context,
      reason: request.interrupt?.reason,
      ttlMs: request.interrupt?.ttlMs,
      expiresAt: request.interrupt?.expiresAt,
      metadata: request.interrupt?.metadata,
    })
    return yield* runElicit(interrupt, responseSchema, context)
  }

  function* elicitDynamic(options: DynamicElicitOptions): Operation<ElicitResult<unknown, unknown>> {
    const interrupt = buildInterrupt({
      key: options.key,
      seq: agentInterruptSeq++,
      message: options.message,
      responseSchema: options.responseSchema,
      contextSchema: options.contextSchema,
      context: options.context,
      reason: options.reason,
      ttlMs: options.ttlMs,
      expiresAt: options.expiresAt,
      metadata: options.metadata,
    })
    return yield* runElicit(interrupt, options.responseSchema, options.context)
  }

  function* notify(message: string, fraction?: number, level: LogLevel = 'info'): Operation<void> {
    const event: DistributiveOmit<AgentEvent, 'lsn' | 'timestamp'> =
      fraction === undefined
        ? { type: 'progress', message, level }
        : { type: 'progress', message, fraction, level }
    yield* emit(event)
  }

  function* log(level: LogLevel, message: string): Operation<void> {
    yield* emit({ type: 'log', level, message })
  }

  const agents = buildAgentsSugar(agent, call)
  const tools = buildToolsSugar(agent, call)

  const ctx: AgentCtx = {
    call: call as AgentCtx['call'],
    callResult: callResult as AgentCtx['callResult'],
    agents,
    tools,
    sample,
    elicit,
    elicitDynamic,
    notify,
    log,
    state,
    history: messages,
    messages,
  }
  return ctx
}

// ============================================================================
// Tool invocation and sugar generation
// ============================================================================

function isUnifiedToolFactory(v: unknown): v is UnifiedToolFactory {
  return (
    typeof v === 'function' &&
    (typeof (v as UnifiedToolFactory).capabilities !== 'undefined' ||
      typeof (v as UnifiedToolFactory).elicits !== 'undefined')
  )
}

function isCoreToolFactory(v: unknown): v is () => Operation<(args: unknown) => Operation<unknown>> {
  return typeof v === 'function'
}

function* invokeTool(factory: unknown, input: unknown, toolCtx: ToolCtx): Operation<unknown> {
  if (isUnifiedToolFactory(factory)) {
    const invoke = yield* (factory as UnifiedToolFactory)(toolCtx)
    return yield* invoke(input)
  }
  const tool = yield* (factory as () => Operation<(args: unknown) => Operation<unknown>>)()
  return yield* tool(input)
}

function buildAgentsSugar(
  agent: AgentFactory,
  call: (target: CompositionTarget, input: unknown) => Operation<unknown>,
): AgentCtx['agents'] {
  const map: Record<string, (input: unknown) => Operation<unknown>> = {}
  for (const [key, factory] of Object.entries((agent.subAgents ?? {}) as Record<string, AgentFactory>)) {
    map[key] = (input: unknown) => call(factory, input)
  }
  return map as unknown as AgentCtx['agents']
}

function buildToolsSugar(
  agent: AgentFactory,
  call: (target: CompositionTarget, input: unknown) => Operation<unknown>,
): AgentCtx['tools'] {
  const map: Record<string, (input: unknown) => Operation<unknown>> = {}
  for (const key of Object.keys(agent.tools)) {
    map[key] = (input: unknown) => call(key, input)
  }
  return map as unknown as AgentCtx['tools']
}

// ============================================================================
// Exchange helpers
// ============================================================================

function createToolUseMessage(name: string, callId: string, input: unknown): Message & { role: 'assistant' } {
  return createMessage('assistant', {
    type: 'tool_use',
    id: callId,
    name,
    input: asRecord(input),
  }, nextMessageId('tool-use')) as Message & { role: 'assistant' }
}

function createToolResultMessage(callId: string, result: unknown, isError = false): Message & { role: 'user' } {
  return createMessage('user', {
    type: 'tool_result',
    toolUseId: callId,
    content: [{ type: 'text', text: toTextContent(result) }],
    ...(isError ? { isError: true } : {}),
  }, nextMessageId('tool-result')) as Message & { role: 'user' }
}

function createElicitExchange<TContext>(
  interrupt: InterruptDescriptor,
  context: TContext,
  content: unknown,
): ElicitExchange<TContext> {
  const toolUseId = interrupt.id
  const request = createMessage('assistant', [
    { type: 'text', text: interrupt.message },
    { type: 'tool_use', id: toolUseId, name: interrupt.key, input: {} },
  ], nextMessageId('elicit-req')) as Message & { role: 'assistant' }
  const response = createMessage('user', {
    type: 'tool_result',
    toolUseId,
    content: [{ type: 'text', text: toTextContent(content) }],
  }, nextMessageId('elicit-res')) as Message & { role: 'user' }
  return {
    context,
    request,
    response,
    messages: [request, response],
    withArguments(fn) {
      const withArgs = cloneMessageWithToolInput(request, fn(context)) as Message & { role: 'assistant' }
      return [withArgs, response]
    },
  }
}

function normalizeSampleResult<TParsed>(
  options: SampleOptions<TParsed>,
  raw: Partial<SampleResult<TParsed>> & { content: string; raw?: unknown },
): SampleResult<TParsed> {
  if (raw.exchange) {
    return {
      content: raw.content,
      exchange: raw.exchange,
      parsed: raw.parsed,
      ...(raw.parseError !== undefined ? { parseError: raw.parseError } : {}),
      ...(raw.raw !== undefined ? { raw: raw.raw } : {}),
    }
  }
  const exchange = createSampleExchange(options, raw.content, raw.raw) as SampleExchange<TParsed>
  return {
    content: raw.content,
    exchange,
    parsed: exchange.parsed,
    ...(exchange.parseError !== undefined ? { parseError: exchange.parseError } : {}),
    ...(raw.raw !== undefined ? { raw: raw.raw } : {}),
  }
}

function createSampleExchange<TParsed>(
  options: SampleOptions<TParsed>,
  content: string,
  raw?: unknown,
): SampleExchange<TParsed> {
  const promptText = options.prompt ?? (options.messages ?? []).map(messageText).join('\n')
  const request = createMessage('user', promptText, nextMessageId('sample-req')) as Message & { role: 'user' }
  if (!options.schema) {
    const response = createMessage('assistant', content, nextMessageId('sample-res')) as Message & { role: 'assistant' }
    return { request, response, messages: [request, response], parsed: undefined as TParsed | undefined }
  }

  const parsedPayload = parseStructuredPayload(content, raw)
  const validation = validateWithSchema(options.schema, parsedPayload)
  const parsed = validation.ok ? (validation.value as TParsed) : undefined
  const parseError = validation.ok ? undefined : validation.message
  const toolUseId = `schema-${generateId()}`
  const response = createMessage('assistant', {
    type: 'tool_use',
    id: toolUseId,
    name: '__schema__',
    input: {},
  }, nextMessageId('sample-schema')) as Message & { role: 'assistant' }
  const toolResult = createMessage('user', {
    type: 'tool_result',
    toolUseId,
    content: [{ type: 'text', text: toTextContent(validation.ok ? validation.value : parsedPayload) }],
    ...(validation.ok ? {} : { isError: true }),
  }, nextMessageId('sample-schema-result'))

  return {
    request,
    response,
    messages: [request, response, toolResult],
    parsed,
    ...(parseError ? { parseError } : {}),
  }
}

function cloneMessageWithToolInput(message: Message, input: Record<string, unknown>): Message {
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === 'tool_use' ? { ...part, input } : part,
    ),
  }
}

// ============================================================================
// Interrupt helpers
// ============================================================================

function buildInterrupt(options: {
  key: string
  seq: number
  message: string
  responseSchema?: unknown | undefined
  contextSchema?: unknown | undefined
  context?: unknown | undefined
  toolCallId?: string | undefined
  reason?: InterruptReason | undefined
  ttlMs?: number | undefined
  expiresAt?: string | undefined
  metadata?: Record<string, unknown> | undefined
}): InterruptDescriptor {
  const expiresAt = resolveExpiresAt(options.expiresAt, options.ttlMs)
  const reason = options.reason ?? (options.toolCallId ? 'tool_call' : 'input_required')
  return {
    id: `${options.key}-${generateId()}`,
    key: options.key,
    seq: options.seq,
    reason,
    message: options.message,
    ...(options.responseSchema !== undefined ? { responseSchema: options.responseSchema } : {}),
    ...(options.contextSchema !== undefined ? { contextSchema: options.contextSchema } : {}),
    ...(options.context !== undefined ? { context: options.context } : {}),
    ...(options.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(options.metadata && Object.keys(options.metadata).length > 0 ? { metadata: options.metadata } : {}),
  }
}

function resolveExpiresAt(expiresAt?: string | undefined, ttlMs?: number | undefined): string | undefined {
  if (expiresAt !== undefined) {
    const ts = Date.parse(expiresAt)
    if (!Number.isFinite(ts)) throw codedError('invalid_interrupt_expiry', `Malformed expiresAt: ${expiresAt}`)
    return new Date(ts).toISOString()
  }
  if (ttlMs !== undefined) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw codedError('invalid_interrupt_expiry', `Invalid ttlMs: ${ttlMs}`)
    return new Date(Date.now() + ttlMs).toISOString()
  }
  return undefined
}

function extractContext(options: Record<string, unknown> & { message: string }): unknown {
  const { message: _message, interrupt: _interrupt, schema: _schema, responseSchema: _responseSchema, contextSchema: _contextSchema, ...rest } = options
  if ('context' in rest && Object.keys(rest).length === 1) return rest['context']
  return rest
}

function validateContext(schema: unknown, context: unknown): unknown {
  const validation = validateWithSchema(schema, context)
  if (!validation.ok) throw codedError('invalid_elicit_context', validation.message)
  return validation.value
}

function validateWithSchema(schema: unknown, value: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!schema || typeof (schema as { safeParse?: unknown }).safeParse !== 'function') {
    return { ok: true, value }
  }
  const result = (schema as { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { message?: string } } }).safeParse(value)
  if (!result.success) {
    return { ok: false, message: result.error?.message ?? 'validation failed' }
  }
  return { ok: true, value: result.data }
}

function normalizeIncomingElicit(incoming: IncomingElicitResponse): RawElicitResult {
  if ('action' in incoming) {
    if (incoming.action === 'accept') return { action: 'accept', content: incoming.content }
    if (incoming.action === 'decline') {
      return incoming.reason === undefined
        ? { action: 'decline' }
        : { action: 'decline', reason: incoming.reason }
    }
    return incoming.reason === undefined
      ? { action: 'cancel' }
      : { action: 'cancel', reason: incoming.reason }
  }
  if (incoming.status === 'accepted') return { action: 'accept', content: incoming.value }
  if (incoming.status === 'declined') {
    return incoming.reason === undefined
      ? { action: 'decline' }
      : { action: 'decline', reason: incoming.reason }
  }
  return incoming.reason === undefined
    ? { action: 'cancel' }
    : { action: 'cancel', reason: incoming.reason }
}

function extractNormalizedElicits(factory: unknown): NormalizedElicitsMap {
  const raw = (factory as { elicits?: unknown }).elicits
  if (!raw || typeof raw !== 'object') return {}
  return raw as NormalizedElicitsMap
}

function parseStructuredPayload(content: string, raw: unknown): unknown {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') return raw
  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value }
}

function toTextContent(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (val as Record<string, unknown>)[key]
          return acc
        }, {})
    }
    return val
  })
}

function codedError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

function* emitCheckpoint(
  stream: AgentStream,
  messages: AgentMessage[],
  state: AgentState,
  pendingInterruptIds: string[],
): Operation<void> {
  const checkpoint = {
    contextId: stream.contextId,
    atLsn: -1,
    messages: messages.map((m) => ({ ...m, content: normalizeContent(m.content) })),
    pendingInterruptIds,
    pendingSubSessions: [],
    pendingRequests: pendingInterruptIds.map((id) => ({ requestId: id, type: 'elicit' as const })),
    state: { ...state },
  }
  const appended = (yield* stream.append({ type: 'checkpoint', checkpoint } as unknown as AgentEvent)) as AgentEvent & { lsn: number }
  checkpoint.atLsn = appended.lsn
  stream.recordCheckpoint(appended.lsn)
}

// ============================================================================
// Misc helpers
// ============================================================================

export function effectiveSystemPrompt(agent: AgentFactory): string {
  return agent.goal
    ? `${agent.systemPrompt}\n\nGoal: ${agent.goal}`
    : agent.systemPrompt
}

export class UnresolvableTargetError extends Error {
  constructor(target: unknown, agent: AgentFactory) {
    const available = [
      ...Object.keys(agent.tools),
      ...Object.keys(agent.subAgents ?? {}),
    ].join(', ')
    super(
      `Cannot resolve ctx.call target "${String(target)}" on agent ` +
        `"${agent.name}". Available tools/sub-agents: ${available || '(none)'}`,
    )
    this.name = 'UnresolvableTargetError'
  }
}

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
