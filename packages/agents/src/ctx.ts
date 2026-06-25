/**
 * AgentCtx — the harness/tool authoring vocabulary.
 *
 * `ctx.call` is the single composition primitive (Spec REQ-003). `ctx.agents`
 * and `ctx.tools` are generated typed sugar over `ctx.call` (REQ-004).
 * `ctx.sample`/`ctx.elicit`/`ctx.notify` are the reasoning/request/progress
 * operations (REQ-009). Elicit/sample park on a shared router so replies route
 * back by `requestId` through arbitrary nesting (REQ-015).
 */

import { withResolvers } from 'effection'
import type { Operation } from 'effection'

import type { AnyToolFactory } from '@sweatpants/core'

import type {
  AgentFactory,
  AgentInput,
  AgentOutput,
  ModelSelection,
} from './types.ts'
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  DistributiveOmit,
  ElicitRequest,
  ElicitResult,
  SampleOptions,
  SampleResult,
} from './events.ts'
import type { AgentStream } from './stream.ts'

// ============================================================================
// Sample provider (the agent's model — fulfils ctx.sample locally)
// ============================================================================

export interface SampleRequest {
  model: ModelSelection
  messages: AgentMessage[]
  options?: SampleOptions
  systemPrompt: string
}

export interface SampleProvider {
  sample(request: SampleRequest): Operation<SampleResult>
}

// ============================================================================
// Request router — elicit/sample parking + requestId-correlated delivery
// ============================================================================

export interface RequestRouter {
  /** Park until a respondElicit arrives for requestId. */
  awaitElicit(requestId: string): Operation<ElicitResult>
  /** Park until a respondSample arrives for requestId. */
  awaitSample(requestId: string): Operation<SampleResult>
  /** Deliver an elicit response; returns false if requestId is unknown. */
  resolveElicit(requestId: string, result: ElicitResult): boolean
  /** Deliver a sample response; returns false if requestId is unknown. */
  resolveSample(requestId: string, result: SampleResult): boolean
  /** Remove a requestId (cleanup on cancel). */
  forget(requestId: string): void
}

interface Mailbox<T> {
  resolvers: ReturnType<typeof withResolvers<T>>
  resolved: boolean
}

export function createRequestRouter(): RequestRouter {
  const elicitMailboxes = new Map<string, Mailbox<ElicitResult>>()
  const sampleMailboxes = new Map<string, Mailbox<SampleResult>>()

  function mailbox<T>(
    store: Map<string, Mailbox<T>>,
    requestId: string,
  ): Mailbox<T> {
    let mb = store.get(requestId)
    if (!mb) {
      mb = { resolvers: withResolvers<T>(), resolved: false }
      store.set(requestId, mb)
    }
    return mb
  }

  function* awaitOne<T>(
    store: Map<string, Mailbox<T>>,
    requestId: string,
  ): Operation<T> {
    const mb = mailbox(store, requestId)
    // withResolvers is sticky: if resolve() already ran, this returns at once.
    return yield* mb.resolvers.operation
  }

  function resolve<T>(
    store: Map<string, Mailbox<T>>,
    requestId: string,
    result: T,
  ): boolean {
    const mb = mailbox(store, requestId)
    if (mb.resolved) return false
    mb.resolved = true
    mb.resolvers.resolve(result)
    return true
  }

  return {
    *awaitElicit(requestId) {
      return yield* awaitOne(elicitMailboxes, requestId)
    },
    *awaitSample(requestId) {
      return yield* awaitOne(sampleMailboxes, requestId)
    },
    resolveElicit(requestId, result) {
      return resolve(elicitMailboxes, requestId, result)
    },
    resolveSample(requestId, result) {
      return resolve(sampleMailboxes, requestId, result)
    },
    forget(requestId) {
      elicitMailboxes.delete(requestId)
      sampleMailboxes.delete(requestId)
    },
  }
}

// ============================================================================
// AgentCtx interface
// ============================================================================

export interface AgentCtx<
  TTools extends Record<string, AnyToolFactory> = Record<string, AnyToolFactory>,
  TSub extends
    | Record<string, AgentFactory<any, any, any, any>>
    | undefined = Record<string, AgentFactory<any, any, any, any>>,
> {
  /** The single composition primitive (REQ-003). */
  call(target: CompositionTarget, input: unknown): Operation<unknown>
  /** Generated sugar over ctx.call for sub-agents (REQ-004). */
  agents: SugarMap<TSub>
  /** Generated sugar over ctx.call for tools (REQ-004). */
  tools: SugarMap<TTools>
  /** Reason with the model (REQ-009). Streams text deltas as progress. */
  sample(options: SampleOptions): Operation<SampleResult>
  /** Request user input mid-execution; parks until respondElicit (REQ-014). */
  elicit(key: string, request: ElicitRequest): Operation<ElicitResult>
  /** Stream a progress notification (REQ-009). */
  notify(message: string, fraction?: number): Operation<void>
  /** Externalized harness state for durability (REQ-010). */
  state: AgentState
  /** Conversation messages (REQ-010). */
  messages: readonly AgentMessage[]
}

export type CompositionTarget =
  | string
  | AgentFactory<any, any, any, any>
  | RemoteHandle

/**
 * Opaque handle to a remote agent/tool fulfilled over a transport (A2A or
 * agentcore). Stage 2 implements routing; stage 1 defines the shape so
 * `ctx.call(remote, input)` is structurally identical (REQ-017).
 */
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

/**
 * Sugar accessor map: each key maps to a typed `(input) => Operation<out>`.
 *
 * IMPORTANT (review CB-1): use `M[K]` — NOT `infer V` over the whole map.
 * The prior `M extends Record<string, infer V>` distributed `V` to the union
 * of all factories, so every accessor became a union-of-functions whose
 * `ReturnType` collapsed to `never` — losing per-accessor input/output
 * inference. Indexing `M[K]` per key keeps each accessor typed by its own
 * target. Do not change this back to `infer V`.
 */
type SugarMap<M> = M extends Record<string, unknown>
  ? {
      [K in keyof M]: M[K] extends AgentFactory<any, any, any, any>
        ? (input: AgentInput<M[K]>) => Operation<AgentOutput<M[K]>>
        : (input: ToolInput<M, K>) => Operation<ToolOutput<M, K>>
    }
  : Record<string, never>

type ToolInput<M, K extends keyof M> = M[K] extends AnyToolFactory
  ? import('@sweatpants/core').InputFromFactory<M[K]>
  : never
type ToolOutput<M, K extends keyof M> = M[K] extends AnyToolFactory
  ? import('@sweatpants/core').OutputFromFactory<M[K]>
  : never

// ============================================================================
// AgentInstance (activation result)
// ============================================================================

export interface AgentInstance<
  I = unknown,
  O = unknown,
> {
  readonly factory: AgentFactory<I, O, any, any>
  invoke(input: I): Operation<O>
}

// ============================================================================
// Builder
// ============================================================================

export interface BuildCtxOptions {
  agent: AgentFactory
  stream: AgentStream
  /** This ctx's subSessionId; undefined for the root harness. */
  subSessionId: string | undefined
  router: RequestRouter
  sampleProvider: SampleProvider | undefined
  messages: AgentMessage[]
  state: AgentState
  /** Provided by the driver to recursively fulfil sub-agent calls (REQ-006). */
  invokeSubAgent: (
    factory: AgentFactory,
    input: unknown,
    subSessionId: string,
  ) => Operation<unknown>
}

export function buildAgentCtx(opts: BuildCtxOptions): AgentCtx {
  const { agent, stream, subSessionId, router, sampleProvider, messages, state } = opts

  function* emit(event: DistributiveOmit<AgentEvent, 'lsn' | 'timestamp'>): Operation<void> {
    const withSub =
      subSessionId && !('subSessionId' in event)
        ? { ...event, subSessionId }
        : { ...event }
    yield* stream.append({ ...(withSub as object) } as AgentEvent)
  }

  function* call(
    target: CompositionTarget,
    input: unknown,
  ): Operation<unknown> {
    const subSessionId = `${agent.name}-${generateId()}`

    if (typeof target === 'string') {
      const toolFactory = (agent.tools as Record<string, AnyToolFactory>)[target]
      if (!toolFactory) {
        throw new UnresolvableTargetError(target, agent)
      }
      yield* emit({ type: 'tool_call_start', subSessionId, toolName: target, callId: subSessionId, input })
      try {
        const tool = yield* toolFactory()
        const result = yield* (tool as (args: unknown) => Operation<unknown>)(input)
        yield* emit({ type: 'tool_call_end', subSessionId, callId: subSessionId, result })
        return result
      } catch (err) {
        yield* emit({ type: 'tool_call_end', subSessionId, callId: subSessionId, error: messageOf(err) })
        throw err
      }
    }

    if (isAgentFactory(target)) {
      yield* emit({ type: 'sub_session_start', subSessionId, target: target.name, input })
      try {
        const result = yield* opts.invokeSubAgent(target, input, subSessionId)
        yield* emit({ type: 'sub_session_end', subSessionId, result })
        return result
      } catch (err) {
        yield* emit({ type: 'sub_session_end', subSessionId, error: messageOf(err) })
        throw err
      }
    }

    if (isRemoteHandle(target)) {
      // Stage 2: route over A2A / agentcore transport. The calling code is
      // structurally identical to a local call (REQ-017); only the fulfilment
      // differs. We define the seam now and error clearly until transports land.
      throw new Error(
        `Remote handle "${target.name}" (kind=${target.kind}) is not yet ` +
          `supported. A2A/agentcore transports are implemented in stage 2.`,
      )
    }

    throw new UnresolvableTargetError(target, agent)
  }

  function* sample(options: SampleOptions): Operation<SampleResult> {
    if (!sampleProvider) {
      // No local model: emit a sample_request and park for a remote response
      // (e.g. the parent/client supplies the model). REQ-015 propagation.
      const requestId = `sample-${generateId()}`
      yield* emit({ type: 'sample_request', requestId, messages: [...messages], options })
      return yield* router.awaitSample(requestId)
    }
    const result = yield* sampleProvider.sample({
      model: agent.model,
      messages: [...messages],
      options,
      systemPrompt: effectiveSystemPrompt(agent),
    })
    // Stream the content as a text_delta (progress) on the stream.
    const messageId = `msg-${generateId()}`
    if (result.content) {
      yield* emit({ type: 'text_delta', messageId, delta: result.content })
    }
    return result
  }

  function* elicit(key: string, request: ElicitRequest): Operation<ElicitResult> {
    const requestId = `elicit-${generateId()}`
    yield* emit({ type: 'elicit_request', requestId, key, message: request.message, schema: request.schema })
    return yield* router.awaitElicit(requestId)
  }

  function* notify(message: string, fraction?: number): Operation<void> {
    const event: DistributiveOmit<AgentEvent, 'lsn' | 'timestamp'> =
      fraction === undefined
        ? { type: 'progress', message }
        : { type: 'progress', message, fraction }
    yield* emit(event)
  }

  const agents = buildAgentsSugar(agent, call)
  const tools = buildToolsSugar(agent, call)

  const ctx: AgentCtx = {
    call,
    agents,
    tools,
    sample,
    elicit,
    notify,
    state,
    messages,
  }
  return ctx
}

// ============================================================================
// Sugar generation
// ============================================================================

function buildAgentsSugar(
  agent: AgentFactory,
  call: (target: CompositionTarget, input: unknown) => Operation<unknown>,
): AgentCtx['agents'] {
  const map: Record<string, (input: unknown) => Operation<unknown>> = {}
  for (const [key, factory] of Object.entries(
    (agent.subAgents ?? {}) as Record<string, AgentFactory>,
  )) {
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
// Helpers
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
