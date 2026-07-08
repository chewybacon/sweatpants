import type { Operation } from 'effection'

import { waitToken } from './token.ts'
import {
  type AnswerPayload,
  type CapabilityResolver,
  type LogRecord,
  type FoldSessionHost,
  type Session,
  type WaitKind,
  type WaitPayloadByKind,
} from './types.ts'

export interface ResolverCallContext {
  parent: FoldSessionHost
  callWaitSeq: number
}

export interface SessionAwareCapabilityResolver extends CapabilityResolver {
  callWithSession(target: string, input: unknown, context: ResolverCallContext): Operation<AnswerPayload>
  cancelChildren?(reason?: string): Operation<void>
}

export interface LoopbackResolverOptions {
  createChild(target: string, input: unknown): Operation<Session>
  ttlPolicy?: (childExpiresAt: string | undefined) => string | undefined
}

/**
 * Zeroth projection helper: re-emit child waits on the parent log with
 * parent-minted identity, relay parent answers downward, and answer the parent
 * call-wait with the child's terminal result. Correlation stays in this
 * resolver closure and never appears in parent-visible wait records.
 *
 * Phase-1 limitation: the correlation map is held in-process by the resolver
 * closure and does not survive parent-process crash/restore. Re-delivery
 * dedupe is therefore honoured within a single resolver lifetime but not
 * across restore (REQ-035 scaffolded).
 */
export function createLoopbackResolver(options: LoopbackResolverOptions): SessionAwareCapabilityResolver {
  const activeChildren = new Set<Session>()
  const correlations = new Map<string, number>()

  return {
    *call(target: string, input: unknown): Operation<AnswerPayload> {
      const child = yield* options.createChild(target, input)
      activeChildren.add(child)
      try {
        return yield* completeChildWithoutReparenting(child)
      } finally {
        activeChildren.delete(child)
      }
    },
    *callWithSession(target: string, input: unknown, context: ResolverCallContext): Operation<AnswerPayload> {
      if (!isFoldSessionHost(context.parent)) {
        return yield* this.call(target, input)
      }

      const child = yield* options.createChild(target, input)
      activeChildren.add(child)
      const childEvents = yield* child.events()
      try {
        let next = yield* childEvents.next()
        while (!next.done) {
          const record = next.value
          if (record.kind === 'wait' && isReparentableWait(record.wait)) {
            const correlationKey = `${context.parent.id}:${context.callWaitSeq}:${child.id}:${record.waitSeq}`
            const existingParentWaitSeq = correlations.get(correlationKey)
            const parentWaitSeq = existingParentWaitSeq ?? (yield* reemitChildWait(context, record, options)).waitSeq
            correlations.set(correlationKey, parentWaitSeq)
            const parentAnswer = yield* waitForAnswer(context.parent, parentWaitSeq)
            try {
              yield* child.respond(waitToken(child.id, record.waitSeq), parentAnswer, {
                idempotencyKey: `loopback:${context.parent.id}:${parentWaitSeq}`,
                wait: record.wait,
              })
            } catch {
              // Child may have been cancelled/fated while we waited for the
              // parent answer. Continue draining — the child terminal gives us
              // the outcome.
            }
            // Continue draining child events — the answer was relayed down but
            // the child must still run to terminal; the parent call-wait is
            // answered with the child's terminal result, not the relayed answer.
            next = yield* childEvents.next()
            continue
          }
          if (record.kind === 'terminal') {
            return record.outcome === 'result'
              ? { ok: true, value: record.payload }
              : { ok: false, code: record.outcome === 'cancelled' ? 'resume_unavailable' : 'session_lost', details: record.payload }
          }
          next = yield* childEvents.next()
        }
        return { ok: false, code: 'session_lost', message: 'Child session completed without result' }
      } finally {
        activeChildren.delete(child)
      }
    },
    *cancelChildren(reason?: string): Operation<void> {
      const children = Array.from(activeChildren)
      for (const child of children) {
        yield* child.cancel(reason)
        activeChildren.delete(child)
      }
    },
  }
}

function* reemitChildWait<K extends WaitKind>(
  context: ResolverCallContext,
  record: Extract<LogRecord, { kind: 'wait'; wait: K }>,
  options: LoopbackResolverOptions,
): Operation<{ waitSeq: number }> {
  const expiresAt = clampTtl(record.expiresAt, options.ttlPolicy?.(record.expiresAt))
  return yield* context.parent.emitWait(
    record.wait,
    record.payload as WaitPayloadByKind[K],
    expiresAt !== undefined ? { expiresAt } : undefined,
  )
}

/**
 * TTL clamp: the re-emitted wait's deadline MUST NOT exceed the child's
 * deadline (REQ-036). The effective deadline is `min(childExpiresAt,
 * parentPolicyExpiresAt)`; if either side is absent, the other governs.
 */
function clampTtl(
  childExpiresAt: string | undefined,
  parentPolicyExpiresAt: string | undefined,
): string | undefined {
  if (childExpiresAt === undefined) {
    return parentPolicyExpiresAt
  }
  if (parentPolicyExpiresAt === undefined) {
    return childExpiresAt
  }
  return Date.parse(childExpiresAt) <= Date.parse(parentPolicyExpiresAt)
    ? childExpiresAt
    : parentPolicyExpiresAt
}

function isFoldSessionHost(session: Session): session is FoldSessionHost {
  return 'emitWait' in session && typeof (session as { emitWait?: unknown }).emitWait === 'function'
}

function isReparentableWait(kind: WaitKind): kind is 'elicit' | 'sample' | 'message' {
  return kind === 'elicit' || kind === 'sample' || kind === 'message'
}

function* waitForAnswer(session: Session, waitSeq: number): Operation<AnswerPayload> {
  const events = yield* session.events()
  let next = yield* events.next()
  while (!next.done) {
    const record: LogRecord = next.value
    if (record.kind === 'answer' && record.waitSeq === waitSeq) {
      return record.payload
    }
    if (record.kind === 'fate' && record.waitSeq === waitSeq) {
      return { ok: false, code: 'resume_unavailable', message: `Wait ${waitSeq} fated ${record.fate}` }
    }
    next = yield* events.next()
  }
  return { ok: false, code: 'session_lost', message: 'Parent session ended before answer' }
}

function* completeChildWithoutReparenting(child: Session): Operation<AnswerPayload> {
  const events = yield* child.events()
  let next = yield* events.next()
  while (!next.done) {
    if (next.value.kind === 'terminal') {
      return next.value.outcome === 'result'
        ? { ok: true, value: next.value.payload }
        : { ok: false, code: 'session_lost', details: next.value.payload }
    }
    next = yield* events.next()
  }
  return { ok: false, code: 'session_lost', message: 'Child session ended without terminal result' }
}
