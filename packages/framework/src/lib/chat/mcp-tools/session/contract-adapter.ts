import { each, resource, spawn, type Operation } from 'effection'
import {
  SessionContractError,
  createInMemorySession,
  type InMemorySession,
  type MessageInput,
  type ResolutionMeta,
  type RespondAck,
  type SendAck,
  type Session as ContractSession,
  type WaitKind,
} from '@sweatpants/session-contract'

import type { RawElicitResult, RawSampleResult } from '../mcp-tool-types.ts'
import type { ToolSession, ToolSessionEvent } from './types.ts'

interface WaitCorrelation {
  kind: Extract<WaitKind, 'elicit' | 'sample'>
  requestId: string
}

/**
 * Thin adapter that projects the proven ToolSession surface into the wait-based
 * session-contract base profile without editing ToolSession itself.
 */
export function adaptToolSessionToSessionContract<TResult>(
  toolSession: ToolSession<TResult>,
): Operation<ContractSession> {
  return resource(function* (provide) {
    const overlay = yield* createInMemorySession({ sessionId: toolSession.id, mode: 'body' })
    const correlations = new Map<number, WaitCorrelation>()

    yield* spawn(function* () {
      for (const event of yield* each(toolSession.events())) {
        yield* appendProjectedEvent(overlay, correlations, event)
        yield* each.next()
      }
    })

    const session: ContractSession = {
      id: toolSession.id,
      events(afterLSN: number | undefined) {
        return overlay.events(afterLSN)
      },
      *send(_message: MessageInput, _opts?: { idempotencyKey?: string }): Operation<SendAck> {
        throw new SessionContractError('unsupported_operation', 'Base-profile tool sessions do not support send()')
      },
      *respond(waitToken: string, payload: unknown, opts?: { idempotencyKey?: string; wait?: WaitKind; resolution?: ResolutionMeta }): Operation<RespondAck> {
        yield* syncTerminalState(overlay, toolSession)
        const wait = yield* resolvePendingWait(overlay, waitToken)
        const correlation = correlations.get(wait.waitSeq)
        if (!correlation) {
          throw new SessionContractError('unknown_wait', `No underlying request for wait ${wait.waitSeq}`)
        }

        const ack = yield* overlay.respond(waitToken, payload, {
          ...(opts?.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
          wait: correlation.kind,
        })

        if (correlation.kind === 'elicit') {
          yield* toolSession.respondToElicit(correlation.requestId, normalizeElicitResult(payload))
        } else {
          yield* toolSession.respondToSample(correlation.requestId, normalizeSampleResult(payload))
        }

        return ack
      },
      *cancel(reason?: string): Operation<void> {
        yield* syncTerminalState(overlay, toolSession)
        const status = yield* overlay.status()
        if (status.state === 'cancelled' || status.state === 'completed' || status.state === 'failed') {
          return
        }
        yield* overlay.cancel(reason)
        yield* toolSession.cancel(reason)
      },
      *status() {
        yield* syncTerminalState(overlay, toolSession)
        return yield* overlay.status()
      },
    }

    yield* provide(session)
  })
}

function* appendProjectedEvent<TResult>(
  overlay: InMemorySession,
  correlations: Map<number, WaitCorrelation>,
  event: ToolSessionEvent<TResult>,
): Operation<void> {
  switch ((event as { type: string }).type) {
    case 'progress': {
      const progress = event as ExtractToolSessionEvent<TResult, 'progress'>
      yield* appendIgnoringTerminal(function* () {
        yield* overlay.emitEmission({ type: 'progress', message: progress.message, progress: progress.progress })
      })
      return
    }
    case 'log': {
      const log = event as ExtractToolSessionEvent<TResult, 'log'>
      yield* appendIgnoringTerminal(function* () {
        yield* overlay.emitEmission({ type: 'log', level: log.level, message: log.message })
      })
      return
    }
    case 'elicit_request': {
      const elicit = event as ExtractToolSessionEvent<TResult, 'elicit_request'>
      yield* appendIgnoringTerminal(function* () {
        const wait = yield* overlay.emitWait('elicit', {
          key: elicit.key,
          message: elicit.message,
          responseSchema: elicit.schema,
          ...(elicit.context !== undefined ? { context: elicit.context } : {}),
        })
        correlations.set(wait.waitSeq, { kind: 'elicit', requestId: elicit.elicitId })
      })
      return
    }
    case 'sample_request': {
      const sample = event as ExtractToolSessionEvent<TResult, 'sample_request'>
      yield* appendIgnoringTerminal(function* () {
        const options = {
          ...(sample.systemPrompt !== undefined ? { systemPrompt: sample.systemPrompt } : {}),
          ...(sample.maxTokens !== undefined ? { maxTokens: sample.maxTokens } : {}),
          ...(sample.tools !== undefined ? { tools: sample.tools } : {}),
          ...(sample.toolChoice !== undefined ? { toolChoice: sample.toolChoice } : {}),
          ...(sample.schema !== undefined ? { schema: sample.schema } : {}),
        }
        const wait = yield* overlay.emitWait('sample', {
          messages: sample.messages,
          ...(Object.keys(options).length > 0 ? { options } : {}),
        })
        correlations.set(wait.waitSeq, { kind: 'sample', requestId: sample.sampleId })
      })
      return
    }
    case 'result': {
      const result = event as ExtractToolSessionEvent<TResult, 'result'>
      yield* appendIgnoringTerminal(function* () {
        yield* overlay.terminal('result', result.result)
      })
      return
    }
    case 'error': {
      const error = event as ExtractToolSessionEvent<TResult, 'error'>
      yield* appendIgnoringTerminal(function* () {
        yield* overlay.terminal('error', {
          name: error.name,
          message: error.message,
          ...(error.stack !== undefined ? { stack: error.stack } : {}),
        })
      })
      return
    }
    case 'cancelled': {
      const cancelled = event as ExtractToolSessionEvent<TResult, 'cancelled'>
      yield* appendIgnoringTerminal(function* () {
        yield* overlay.terminal('cancelled', cancelled.reason !== undefined ? { reason: cancelled.reason } : undefined)
      })
      return
    }
    default:
      return
  }
}

type ExtractToolSessionEvent<TResult, TType extends string> = Extract<ToolSessionEvent<TResult>, { type: TType }>

function* appendIgnoringTerminal(
  operation: () => Operation<void>,
): Operation<void> {
  try {
    yield* operation()
  } catch (error) {
    if (isTerminalAppend(error)) {
      return
    }
    throw error
  }
}

function isTerminalAppend(error: unknown): boolean {
  if (!(error instanceof SessionContractError)) {
    return false
  }
  return error.code === 'terminal_session'
}

function* resolvePendingWait(overlay: InMemorySession, waitToken: string): Operation<{ waitSeq: number; kind: WaitKind }> {
  const status = yield* overlay.status()
  const wait = status.pendingWaits.find((candidate: { token: string }) => candidate.token === waitToken)
  if (!wait) {
    throw new SessionContractError('resume_unavailable', 'Wait is not pending')
  }
  return { waitSeq: wait.waitSeq, kind: wait.kind }
}

function normalizeElicitResult(payload: unknown): RawElicitResult<unknown> {
  if (isRawElicitResult(payload)) {
    return payload
  }
  return { action: 'accept', content: payload }
}

function normalizeSampleResult(payload: unknown): RawSampleResult {
  if (isRawSampleResult(payload)) {
    return payload
  }
  if (typeof payload === 'string') {
    return { text: payload }
  }
  return { text: JSON.stringify(payload) }
}

function isRawElicitResult(payload: unknown): payload is RawElicitResult<unknown> {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      'action' in payload &&
      typeof (payload as { action?: unknown }).action === 'string',
  )
}

function isRawSampleResult(payload: unknown): payload is RawSampleResult {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      'text' in payload &&
      typeof (payload as { text?: unknown }).text === 'string',
  )
}

function* syncTerminalState<TResult>(overlay: InMemorySession, toolSession: ToolSession<TResult>): Operation<void> {
  const overlayStatus = yield* overlay.status()
  if (overlayStatus.state === 'completed' || overlayStatus.state === 'failed' || overlayStatus.state === 'cancelled') {
    return
  }

  const toolStatus = yield* toolSession.status()
  if (toolStatus === 'orphaned') {
    yield* appendIgnoringTerminal(function* () {
      yield* overlay.terminal('error', { code: 'session_lost', message: 'Underlying tool session was orphaned' })
    })
  }
}
