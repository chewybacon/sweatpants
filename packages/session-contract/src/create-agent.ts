import type { Operation } from 'effection'

import { assertDeclaredCapability, listCapabilities } from './capabilities.ts'
import { CapabilityResolverContext, ModelProviderContext } from './contexts.ts'
import { createInMemorySession, type CreateInMemorySessionOptions } from './in-memory-session.ts'
import { waitToken } from './token.ts'
import {
  type AnswerPayload,
  type CapabilityMap,
  type CapabilityResolver,
  type FoldSessionHost,
  type MessageInput,
  type ModelProvider,
  type Session,
} from './types.ts'

export interface AgentConfig<C extends CapabilityMap = CapabilityMap> {
  name?: string
  capabilities?: C
  model?: ModelProvider
  resolver?: CapabilityResolver
  system?: string
  maxIterations?: number
}

export interface Agent<C extends CapabilityMap = CapabilityMap> {
  readonly name: string
  readonly capabilities: C
  listCapabilities: typeof listCapabilities
  createSession(options: { sessionId: string; bufferStore?: CreateInMemorySessionOptions['bufferStore'] }): Operation<Session>
}

/**
 * Phase-1 fold-mode agent harness.
 *
 * IMPORTANT: This is a synchronous simulation of the fold, not a full-profile
 * durable driver. `send()` appends the message and then synchronously runs the
 * entire sample→dispatch→append turn before returning the ack. A full-profile
 * fold would make `send()` an append-anytime durable ack with an independently
 * restorable driver loop consuming the derived message queue. See REQ-046
 * (scaffolded).
 *
 * The synchronous simulation is sufficient to exercise the log grammar,
 * capability declaration, scope-injected resolution, and re-parenting in
 * tests, but `send()` can block for the duration of a delegated turn and
 * mid-turn exceptions can leave a partially advanced log.
 *
 * For the async fold driver (REQ-087), use `spawnFoldDriver()` from
 * `fold-driver.ts`. The async driver makes `send()` append + ack only and
 * consumes the message queue independently.
 */
export function createAgent<C extends CapabilityMap = CapabilityMap>(config: AgentConfig<C>): Agent<C> {
  const capabilities = config.capabilities ?? ({} as C)
  const name = config.name ?? 'agent'

  return {
    name,
    capabilities,
    listCapabilities,
    *createSession(options: { sessionId: string; bufferStore?: CreateInMemorySessionOptions['bufferStore'] }): Operation<Session> {
      const session = yield* createInMemorySession({
        sessionId: options.sessionId,
        mode: 'fold',
        ...(options.bufferStore !== undefined ? { bufferStore: options.bufferStore } : {}),
      })
      const existing = yield* session.records()
      if (existing.length === 0) {
        yield* session.checkpoint('fold')
        yield* session.emitWait('message', config.system !== undefined ? { prompt: config.system } : {})
      }
      return createFoldSession(session, capabilities, config)
    },
  }
}

function createFoldSession<C extends CapabilityMap>(
  session: FoldSessionHost,
  capabilities: C,
  config: AgentConfig<C>,
): Session {
  return {
    id: session.id,
    events: session.events,
    *send(message, opts) {
      const ack = yield* session.send(message, opts)
      const result = yield* runOneFoldTurn(session, capabilities, message, config)
      yield* session.emitEmission({ type: 'agent_turn_result', result })
      yield* session.checkpoint('fold')
      yield* session.emitWait('message', config.system !== undefined ? { prompt: config.system } : {})
      return ack
    },
    respond: session.respond,
    *cancel(reason) {
      const resolver = config.resolver ?? (yield* CapabilityResolverContext.get())
      const cascade = resolver as CapabilityResolver & { cancelChildren?: (reason?: string) => Operation<void> }
      if (cascade.cancelChildren) {
        yield* cascade.cancelChildren(reason)
      }
      yield* session.cancel(reason)
    },
    status: session.status,
  }
}

export function* runOneFoldTurn<C extends CapabilityMap>(
  session: FoldSessionHost,
  capabilities: C,
  input: MessageInput,
  config: AgentConfig<C>,
): Operation<AnswerPayload> {
  const sample = yield* session.emitWait('sample', {
    messages: [{ role: 'user', content: input.content }],
    ...(config.system ? { options: { system: config.system } } : {}),
  })

  const modelProvider = config.model ?? (yield* ModelProviderContext.get())
  const modelAnswer = modelProvider
    ? yield* modelProvider.sample(sample.payload)
    : ({ ok: true, value: input.content } satisfies AnswerPayload)
  yield* session.respond(waitToken(session.id, sample.waitSeq), modelAnswer, {
    idempotencyKey: `fold:sample:${sample.waitSeq}`,
    wait: 'sample',
  })

  if (!modelAnswer.ok) {
    return modelAnswer
  }

  const value = modelAnswer.value as { call?: { target: string; input: unknown } } | unknown
  if (isCallRequest(value)) {
    assertDeclaredCapability(capabilities, value.call.target)
    const callWait = yield* session.emitWait('call', { target: value.call.target, input: value.call.input })
    const resolver = config.resolver ?? (yield* CapabilityResolverContext.get())
    const callAnswer = resolver
      ? yield* callResolver(resolver, value.call.target, value.call.input, session, callWait.waitSeq)
      : ({ ok: false, code: 'unknown_target', message: `No resolver for ${value.call.target}` } satisfies AnswerPayload)
    yield* session.respond(waitToken(session.id, callWait.waitSeq), callAnswer, {
      idempotencyKey: `fold:call:${callWait.waitSeq}`,
      wait: 'call',
    })
    return callAnswer
  }

  return modelAnswer
}

function* callResolver(
  resolver: CapabilityResolver,
  target: string,
  input: unknown,
  session: FoldSessionHost,
  callWaitSeq: number,
): Operation<AnswerPayload> {
  const maybeSessionAware = resolver as CapabilityResolver & {
    callWithSession?: (target: string, input: unknown, context: { parent: FoldSessionHost; callWaitSeq: number }) => Operation<AnswerPayload>
  }
  if (maybeSessionAware.callWithSession) {
    return yield* maybeSessionAware.callWithSession(target, input, { parent: session, callWaitSeq })
  }
  return yield* resolver.call(target, input)
}

function isCallRequest(value: unknown): value is { call: { target: string; input: unknown } } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'call' in value &&
      (value as { call?: unknown }).call &&
      typeof (value as { call: { target?: unknown } }).call.target === 'string',
  )
}
