/**
 * Fold Driver — handler-spawned async loop that consumes the session's message
 * queue and runs fold turns independently of `send()`.
 *
 * REQ-087: `send()` is append + ack only. The driver runs the fold turn after
 * `send()` returns. The driver is NOT embedded in the `Session` interface.
 *
 * REQ-088: On restore, the handler checks `deriveLogState()` and spawns a
 * fresh driver. The driver is stateless — all restore decisions are derived
 * from the log.
 *
 * Restore semantics per wait kind:
 * - `message` + unconsumed queue → consume immediately (REQ-026)
 * - `message` + empty queue → park, wait for `send()`
 * - `sample` (mid-stream crash) → re-sample, discard old partial emissions (REQ-072)
 * - `call` → resolver reattaches or delivers `session_lost` (REQ-043)
 * - `elicit` → survives with identity, client re-answers (REQ-041)
 *
 * @packageDocumentation
 */

import { sleep } from 'effection'
import type { Operation } from 'effection'

import { CapabilityResolverContext, ModelProviderContext } from './contexts.ts'
import { deriveLogState } from './derive.ts'
import type { InMemorySession } from './in-memory-session.ts'
import { waitToken } from './token.ts'
import {
  type AnswerPayload,
  type CapabilityMap,
  type LogRecord,
  type MessageInput,
  type ModelProvider,
  type CapabilityResolver,
} from './types.ts'
import { assertDeclaredCapability } from './capabilities.ts'
import type { AgentConfig } from './create-agent.ts'

/**
 * Spawns a fold driver that consumes the session's message queue and runs fold
 * turns. The driver runs in the caller's effection scope and is torn down when
 * that scope halts.
 *
 * The driver is stateless: all decisions about what to do next are derived
 * from the session log via `deriveLogState()`.
 */
export function* spawnFoldDriver<C extends CapabilityMap = CapabilityMap>(
  session: InMemorySession,
  config: AgentConfig<C>,
): Operation<void> {
  // Main driver loop
  while (true) {
    const records = yield* session.records()
    const state = deriveLogState(session.id, records)

    // If terminal, the session is done
    if (state.terminal) {
      return
    }

    // Determine what to do based on the derived state
    const action = decideAction(state)

    switch (action.type) {
      case 'run_turn': {
        // Consume the next message and run a fold turn
        const message = action.message
        yield* runFoldTurn(session, config, message)
        // Loop immediately to check for more work
        continue
      }

      case 're_sample': {
        // Mid-stream crash recovery: re-sample
        yield* resample(session, config, action.sampleWaitSeq)
        continue
      }

      case 'reattach_call': {
        // Restore with pending call: reattach or deliver session_lost
        yield* reattachCall(session, config, action.callWaitSeq)
        continue
      }

      case 'park': {
        // No work to do — wait for the session log to change
        yield* waitForLogChange(session)
        continue
      }
    }
  }
}

type DriverAction =
  | { type: 'run_turn'; message: MessageInput }
  | { type: 're_sample'; sampleWaitSeq: number }
  | { type: 'reattach_call'; callWaitSeq: number }
  | { type: 'park' }

/**
 * Derive what the driver should do next from the log state. This is a pure
 * function — no in-memory state.
 */
function decideAction(state: ReturnType<typeof deriveLogState>): DriverAction {
  // Check for pending waits that need restore action
  for (const wait of state.pendingWaits) {
    if (wait.kind === 'sample') {
      // Mid-stream crash: the model was streaming when the process died.
      // Re-sample: discard old partial emissions and emit fresh ones.
      return { type: 're_sample', sampleWaitSeq: wait.waitSeq }
    }
    if (wait.kind === 'call') {
      // Pending call: resolver should reattach or deliver session_lost
      return { type: 'reattach_call', callWaitSeq: wait.waitSeq }
    }
    // elicit waits: the client re-answers via respond(). Park.
  }

  // Check for unconsumed messages (message waits matched to message answers)
  const messageWaits = Array.from(state.waits.values())
    .filter((w) => w.wait === 'message')
    .sort((a, b) => a.waitSeq - b.waitSeq)

  if (
    messageWaits.length > 0 &&
    state.consumedMessageCount === messageWaits.length
  ) {
    // The last message wait has a matched message that hasn't been processed.
    // The message is at index consumedMessageCount - 1 in the message answers.
    const messageAnswers = Array.from(state.idempotency.values())
      .filter((r): r is LogRecord & { kind: 'answer'; waitSeq: undefined } =>
        r.kind === 'answer' && r.waitSeq === undefined && r.wait === 'message')
      .sort((a, b) => a.lsn - b.lsn)
    const message = messageAnswers[state.consumedMessageCount - 1]
    if (message) {
      const payload = message.payload as AnswerPayload
      if (payload.ok) {
        return { type: 'run_turn', message: payload.value as MessageInput }
      }
    }
  }

  // Also handle the case where there are queued messages but no pending waits
  // (messages arrived while the fold was between turns)
  if (state.queuedMessages.length > 0 && state.pendingWaits.length === 0) {
    const msg = state.queuedMessages[0]!
    const payload = msg.payload as AnswerPayload
    if (payload.ok) {
      return { type: 'run_turn', message: payload.value as MessageInput }
    }
  }

  return { type: 'park' }
}

/**
 * Run a single fold turn: sample → dispatch → answer calls → checkpoint →
 * message wait.
 */
function* runFoldTurn<C extends CapabilityMap>(
  session: InMemorySession,
  config: AgentConfig<C>,
  input: MessageInput,
): Operation<void> {
  const capabilities = config.capabilities ?? ({} as C)

  // 1. Emit sample wait
  const sampleWait = yield* session.emitWait('sample', {
    messages: [{ role: input.role ?? 'user', content: input.content }],
    ...(config.system ? { options: { system: config.system } } : {}),
  })

  // 2. Call model provider and answer the sample wait
  const modelProvider: ModelProvider | undefined = config.model ?? (yield* ModelProviderContext.get())
  const modelAnswer: AnswerPayload = modelProvider
    ? yield* modelProvider.sample(sampleWait.payload)
    : { ok: true, value: input.content }

  yield* session.respond(waitToken(session.id, sampleWait.waitSeq), modelAnswer, {
    idempotencyKey: `fold:sample:${sampleWait.waitSeq}`,
    wait: 'sample',
  })

  if (!modelAnswer.ok) {
    // Model error → terminal
    yield* session.terminal('error', modelAnswer)
    return
  }

  // 3. Check for tool calls in the model response
  const value = modelAnswer.value as { call?: { target: string; input: unknown } } | unknown
  if (isCallRequest(value)) {
    assertDeclaredCapability(capabilities, value.call.target)
    const callWait = yield* session.emitWait('call', {
      target: value.call.target,
      input: value.call.input,
    })

    const resolver: CapabilityResolver | undefined = config.resolver ?? (yield* CapabilityResolverContext.get())
    const callAnswer: AnswerPayload = resolver
      ? yield* callResolver(resolver, value.call.target, value.call.input, session, callWait.waitSeq)
      : { ok: false, code: 'unknown_target', message: `No resolver for ${value.call.target}` }

    yield* session.respond(waitToken(session.id, callWait.waitSeq), callAnswer, {
      idempotencyKey: `fold:call:${callWait.waitSeq}`,
      wait: 'call',
    })

    if (!callAnswer.ok) {
      yield* session.terminal('error', callAnswer)
      return
    }
  }

  // 4. Emit emission with the turn result
  yield* session.emitEmission({ type: 'agent_turn_result', result: modelAnswer })

  // 5. Checkpoint + message wait (turn boundary)
  yield* session.checkpoint('fold')
  yield* session.emitWait('message', config.system !== undefined ? { prompt: config.system } : {})
}

/**
 * Re-sample after a mid-stream crash. The old sample wait is answered with a
 * failure (session_lost), and a new sample wait is emitted with the same
 * payload. Old partial emissions remain in the log as inert history (REQ-005).
 *
 * REQ-072: The sample wait identity (waitSeq, token) is preserved.
 */
function* resample<C extends CapabilityMap>(
  session: InMemorySession,
  config: AgentConfig<C>,
  sampleWaitSeq: number,
): Operation<void> {
  // Answer the old sample wait with session_lost (it's inert history now)
  yield* session.respond(
    waitToken(session.id, sampleWaitSeq),
    { ok: false, code: 'session_lost', message: 'mid-stream crash — re-sampling' },
    { wait: 'sample' },
  )

  // Re-run the model request with the same payload
  const records = yield* session.records()
  const state = deriveLogState(session.id, records)
  const oldWait = state.waits.get(sampleWaitSeq)
  if (!oldWait || oldWait.wait !== 'sample') return

  // Emit a new sample wait with the same payload
  const samplePayload = oldWait.payload as { messages: unknown[]; options?: Record<string, unknown> }
  const newSample = yield* session.emitWait('sample', samplePayload)

  const modelProvider: ModelProvider | undefined = config.model ?? (yield* ModelProviderContext.get())
  const modelAnswer: AnswerPayload = modelProvider
    ? yield* modelProvider.sample(newSample.payload)
    : { ok: true, value: 're-sampled' }

  yield* session.respond(waitToken(session.id, newSample.waitSeq), modelAnswer, {
    idempotencyKey: `fold:sample:${newSample.waitSeq}`,
    wait: 'sample',
  })

  // Continue the turn: checkpoint + message wait
  yield* session.emitEmission({ type: 'agent_turn_result', result: modelAnswer })
  yield* session.checkpoint('fold')
  yield* session.emitWait('message', config.system !== undefined ? { prompt: config.system } : {})
}

/**
 * Reattach to a child session or deliver a session_lost failure answer for a
 * pending call wait (REQ-043, REQ-088).
 */
function* reattachCall<C extends CapabilityMap>(
  session: InMemorySession,
  config: AgentConfig<C>,
  callWaitSeq: number,
): Operation<void> {
  const resolver: CapabilityResolver | undefined = config.resolver ?? (yield* CapabilityResolverContext.get())
  if (!resolver) {
    yield* session.respond(
      waitToken(session.id, callWaitSeq),
      { ok: false, code: 'session_lost', message: 'No resolver to reattach' },
      { wait: 'call' },
    )
    return
  }

  // Try to reattach via the resolver. If the resolver doesn't support
  // reattachment, deliver session_lost.
  const maybeSessionAware = resolver as CapabilityResolver & {
    reattachCall?: (waitSeq: number) => Operation<AnswerPayload | null>
  }

  if (maybeSessionAware.reattachCall) {
    const result = yield* maybeSessionAware.reattachCall(callWaitSeq)
    if (result) {
      yield* session.respond(waitToken(session.id, callWaitSeq), result, {
        wait: 'call',
      })
      return
    }
  }

  // Deliver session_lost
  yield* session.respond(
    waitToken(session.id, callWaitSeq),
    { ok: false, code: 'session_lost', message: 'Child session unavailable after restore' },
    { wait: 'call' },
  )
}

/**
 * Wait for the session log to change. Polls the session records with a small
 * delay. This is a simple implementation; a production version would use
 * `session.events()` for push-based notification.
 */
function* waitForLogChange(session: InMemorySession): Operation<void> {
  const initialCount = (yield* session.records()).length
  while (true) {
    yield* sleep(10)
    const currentCount = (yield* session.records()).length
    if (currentCount !== initialCount) return
    // Also check if the session became terminal
    const status = yield* session.status()
    if (status.terminal) return
  }
}

function* callResolver(
  resolver: CapabilityResolver,
  target: string,
  input: unknown,
  session: InMemorySession,
  callWaitSeq: number,
): Operation<AnswerPayload> {
  const maybeSessionAware = resolver as CapabilityResolver & {
    callWithSession?: (target: string, input: unknown, context: { parent: InMemorySession; callWaitSeq: number }) => Operation<AnswerPayload>
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
